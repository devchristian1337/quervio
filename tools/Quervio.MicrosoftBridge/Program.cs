using System.Data;
using System.Data.SqlTypes;
using System.Globalization;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Azure.Core;
using Azure.Identity;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Dac;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Sdk.Sfc;
using Microsoft.SqlServer.Management.Smo;
using Table = Microsoft.SqlServer.Management.Smo.Table;

// NDJSON on standard I/O; connection secrets never appear in process arguments.
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static JsonObject Args = new();
    private static JsonObject Connection = new();
    private static string? Password;
    private static string? LastAccessToken;
    private static bool IdentityLoaded;
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly string IdentityPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "com.quervio.app", "identity.json");
    private static readonly InteractiveBrowserCredential Credential = CreateCredential();
    private static InteractiveBrowserCredential CreateCredential()
    {
        var options = new InteractiveBrowserCredentialOptions { TokenCachePersistenceOptions = new TokenCachePersistenceOptions { Name = "Quervio", UnsafeAllowUnencryptedStorage = false } };
        try { if (File.Exists(IdentityPath)) { using var stream = File.OpenRead(IdentityPath); options.AuthenticationRecord = AuthenticationRecord.Deserialize(stream); IdentityLoaded = true; } } catch (Exception) { IdentityLoaded = false; }
        return new InteractiveBrowserCredential(options);
    }
    private static async Task<AccessToken> Token(string scope)
    {
        var request = new TokenRequestContext([scope]);
        if (!IdentityLoaded || !File.Exists(IdentityPath))
        {
            var record = await Credential.AuthenticateAsync(request);
            Directory.CreateDirectory(Path.GetDirectoryName(IdentityPath)!);
            string temp = IdentityPath + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) record.Serialize(stream);
                File.Move(temp, IdentityPath, true);
                IdentityLoaded = true;
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        var access = await Credential.GetTokenAsync(request);
        LastAccessToken = access.Token;
        return access;
    }
    private static string S(string key, string fallback = "") => Args[key]?.GetValue<string>() ?? fallback;
    private static string SNonEmpty(string key, string fallback) => Args[key]?.GetValue<string>() is { Length: > 0 } value && !string.IsNullOrWhiteSpace(value) ? value : fallback;
    private static bool B(string key, bool fallback = false) => Args[key]?.GetValue<bool>() ?? fallback;
    private static int I(string key, int fallback = 0) => Args[key]?.GetValue<int>() ?? fallback;
    private static bool UseEntra() => B("entra") || Connection["authentication"]?["kind"]?.GetValue<string>() == "entra";
    private static string Q(string name) => "[" + name.Replace("]", "]]") + "]";
    private static string L(string text) => "N'" + text.Replace("'", "''") + "'";
    private static string RedactSecrets(string text)
    {
        var secrets = new HashSet<string>(StringComparer.Ordinal);
        void Add(string? secret)
        {
            if (string.IsNullOrEmpty(secret)) return;
            secrets.Add(secret);
            secrets.Add(secret.Replace("\"", "\"\"", StringComparison.Ordinal));
            secrets.Add(secret.Replace("'", "''", StringComparison.Ordinal));
        }
        Add(Password);
        try { Add(Args["backupPassword"]?.GetValue<string>()); } catch (Exception) { }
        Add(LastAccessToken);
        try
        {
            string? odbc = Args["sourceConnection"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(odbc))
            {
                secrets.Add(odbc);
                foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                    odbc,
                    @"(?:^|;)\s*(?:pwd|password)\s*=\s*(?:\{([^}]*)\}|""((?:""""|[^""])*)""|'((?:''|[^'])*)'|([^;]*))",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                {
                    for (int g = 1; g < match.Groups.Count; g++)
                        if (match.Groups[g].Success) Add(match.Groups[g].Value);
                }
            }
        }
        catch (Exception) { }
        foreach (string secret in secrets.OrderByDescending(s => s.Length))
            text = text.Replace(secret, "[redacted]", StringComparison.Ordinal);
        return text;
    }
    private static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value, Json)); Console.Out.Flush(); }
    private static void Progress(string text, long? count = null) => Emit(new { type = "progress", phase = "running", message = text, completed = count });

    public static async Task<int> Main(string[] options)
    {
        try
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            CultureInfo.DefaultThreadCurrentCulture = Invariant;
            CultureInfo.DefaultThreadCurrentUICulture = Invariant;
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            if (options.Contains("--self-test")) { await SelfTest(); return 0; }
            if (options.Contains("--result-export")) { ResultExport(); return 0; }
            if (options.Contains("--version")) { Emit(new { version = "1.0", runtime = Environment.Version.ToString() }); return 0; }
            if (options.Contains("--access-token")) { var token = await Token("https://database.windows.net/.default"); Emit(new { accessToken = token.Token, expiresOn = token.ExpiresOn.ToUnixTimeSeconds() }); return 0; }
            var request = JsonNode.Parse(await Console.In.ReadLineAsync() ?? "")!.AsObject();
            Args = request["arguments"]?.AsObject() ?? new();
            Connection = request["connection"]!.AsObject(); Password = request["password"]?.GetValue<string>();
            string action = request["action"]!.GetValue<string>();
            bool readOnly = action is "version" or "script" or "dacPreview" or "importPreview" or "export" or "extract" or "bacpacExport" or "azureList" or "azureBackups";
            if (!readOnly && request["confirmed"]?.GetValue<bool>() != true) throw new InvalidOperationException("Operation was not confirmed.");
            if (!OperatingSystem.IsWindows() && (action is "columnEncryption" or "createColumnKeys" or "rotateMasterKey"))
                throw new PlatformNotSupportedException("This Always Encrypted operation uses the Windows certificate store and must run on Windows.");
            object result = action switch
            {
                "version" => new { version = "1.0", runtime = Environment.Version.ToString() },
                "script" => await Script(),
                "extract" or "dacPreview" or "dacPublish" or "bacpacExport" or "bacpacImport" => await Dac(action),
                "importPreview" => await PreviewImport(),
                "import" => await Import(),
                "export" => await Export(),
                "azureList" or "azureBackups" or "azureRestore" or "azureRetention" => await Azure(action),
                "encryptedQuery" => await EncryptedQuery(),
                "columnEncryption" => await ColumnEncryption(),
                "createColumnKeys" => await CreateColumnKeys(),
                "rotateMasterKey" => await RotateMasterKey(),
                _ => throw new InvalidOperationException("Unknown Microsoft operation.")
            };
            Emit(new { type = "result", value = result }); return 0;
        }
        catch (Exception error)
        {
            // Do not serialize connection strings, credentials or arbitrary exception objects.
            var causes = new List<string>();
            for (Exception? e = error; e is not null; e = e.InnerException) { string m = e is SqlException sql ? $"SQL {sql.Number}: {sql.Message}" : e.Message, plain = e is SqlException s ? s.Message : e.Message; if (!causes.Any(c => c.Contains(plain, StringComparison.Ordinal))) causes.Add(m); }
            string text = RedactSecrets(string.Join(" ", causes));
            Emit(new { type = "error", message = text }); return 1;
        }
    }

    private static void ResultExport()
    {
        var header = JsonNode.Parse(Console.In.ReadLine() ?? throw new EndOfStreamException())!.AsObject();
        string path = header["path"]!.GetValue<string>(), temp = path + ".quervio-partial-" + Guid.NewGuid().ToString("N");
        string[] columns = header["columns"]!.AsArray().Select(c => c!.GetValue<string>()).ToArray();
        IEnumerable<string?[]> Rows() { while (true) { string line = Console.In.ReadLine() ?? throw new EndOfStreamException("Result export was interrupted."); if (line == "{\"end\":true}") yield break; yield return JsonSerializer.Deserialize<string?[]>(line) ?? throw new InvalidDataException("Invalid result row."); } }
        try { long rows = WriteWorkbook(temp, columns, Rows()); File.Move(temp, path, true); Emit(new { type = "result", value = new { path, rows } }); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    private static async Task SelfTest()
    {
        string directory = Path.Combine(Path.GetTempPath(), "quervio-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        try
        {
            Args = new JsonObject { ["backslashEscaping"] = true };
            string?[] expected = [null, "", @"\N", @"\prefix", "a,b", "a\"b", "line one\nline two", "à漢字", "99999999999999999999999999999999999999", "one\r\n\nthree", "_x0041_ bell\u0007"];
            string path = Path.Combine(directory, "roundtrip.csv");
            File.WriteAllText(path, string.Join(",", Enumerable.Range(0, expected.Length).Select(i => Csv("c" + i))) + Environment.NewLine + string.Join(",", expected.Select(Csv)) + Environment.NewLine, new UTF8Encoding(true));
            var data = FileRows(path, out var headers).Single();
            if (headers.Length != expected.Length || !data.Select(v => v?.ToString()).SequenceEqual(expected)) throw new Exception("CSV round-trip did not preserve NULL, empty, escaping, Unicode, blank lines or precision.");
            if (ConvertCell("99999999999999999999999999999999999999", "decimal").ToString() != expected[8]) throw new Exception("Decimal(38) precision was lost.");
            if (!Equals(ConvertCell("0", "bit"), false) || !Equals(ConvertCell("1", "bit"), true)) throw new Exception("Bit conversion failed.");
            if (ConvertCell("0x00ABFF", "varbinary") is not byte[] bytes || !bytes.SequenceEqual(new byte[] { 0, 171, 255 })) throw new Exception("Binary conversion failed.");
            string workbook = Path.Combine(directory, "roundtrip.xlsx");
            WriteWorkbook(workbook, Enumerable.Range(0, expected.Length).Select(i => "c" + i).ToArray(), new[] { expected });
            var excel = FileRows(workbook, out var excelHeaders).Single();
            if (excelHeaders.Length != expected.Length || !excel.Select(v => v?.ToString()).SequenceEqual(expected)) throw new Exception("Excel round-trip mismatch: " + string.Join(", ", excel.Select((v, i) => $"{i}: {JsonSerializer.Serialize(v)}")));
            if (ConvertCell(1e15, "decimal").ToString() != "1000000000000000" || !Equals(ConvertCell(new DateTime(1899, 12, 31, 12, 30, 0), "time"), new TimeSpan(12, 30, 0))) throw new Exception("Typed Excel values did not convert.");
            string[] formulas = ["=1+1", "+SUM(A1)", "-1+2", "@SUM(A1)", " \t\r\n=1+1", "\uFEFF=1", "\u200B=1", "＝1+1", "＋SUM(A1)", "－1+2", "＠SUM(A1)"];
            foreach (string formula in formulas)
            {
                foreach (bool escape in new[] { false, true })
                {
                    bool rejected = false;
                    try { CsvField(formula, escape); } catch (InvalidDataException) { rejected = true; }
                    if (!rejected) throw new Exception("CSV accepted formula-like text in a header or value.");
                }
            }
            foreach (string number in new[] { "-123", "+123", "-12.50", "+1.2e-3", "-.5", "-1e999" })
                if (Csv(number) != "\"" + number + "\"") throw new Exception("CSV changed a signed numeric literal.");

            string formulaWorkbook = Path.Combine(directory, "formula-text.xlsx");
            WriteWorkbook(formulaWorkbook, formulas, new[] { formulas });
            if (!FileRows(formulaWorkbook, out var formulaHeaders).Single().Select(v => v?.ToString()).SequenceEqual(formulas) || !formulaHeaders.SequenceEqual(formulas))
                throw new Exception("XLSX did not preserve formula-like headers and values as text.");
            using (var document = SpreadsheetDocument.Open(formulaWorkbook, false))
            {
                var cells = document.WorkbookPart!.WorksheetParts.Single().Worksheet.Descendants<Cell>().ToArray();
                if (cells.Any(cell => cell.CellFormula is not null || cell.DataType?.Value != CellValues.InlineString))
                    throw new Exception("XLSX formula-like data is not an inert text cell.");
            }

            void PackageFixture(string file, string name)
            {
                using var model = new Microsoft.SqlServer.Dac.Model.TSqlModel(Microsoft.SqlServer.Dac.Model.SqlServerVersion.Sql160, new Microsoft.SqlServer.Dac.Model.TSqlModelOptions());
                model.AddObjects($"CREATE TABLE [dbo].[{name}] ([Id] INT NOT NULL);");
                DacPackageExtensions.BuildPackage(file, model, new PackageMetadata { Name = name, Version = "1.0.0" });
            }
            string dacpac = Path.Combine(directory, "selected.dacpac"), alternate = Path.Combine(directory, "alternate.dacpac");
            PackageFixture(dacpac, "Approved"); PackageFixture(alternate, "Alternate");
            using (var snapshot = await DacSnapshot.Load(dacpac))
            {
                string approvedHash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(dacpac)));
                File.Copy(alternate, dacpac, overwrite: true);
                if (snapshot.Hash != approvedHash || snapshot.Package.Name != "Approved")
                    throw new Exception("DACPAC snapshot changed after pathname replacement.");
                bool rejected = false;
                try { using var changed = await DacSnapshot.Load(dacpac, approvedHash); }
                catch (InvalidOperationException) { rejected = true; }
                if (!rejected) throw new Exception("DACPAC publish accepted bytes that differ from the approved hash.");
            }

            // Test 10: ValidateSourceQuery rejects multi-statement, dialect-desync, and write queries while allowing valid SELECT/WITH.
            foreach (string allowedSql in new[]
            {
                "SELECT a, REPLACE(b, 'x', 'y') FROM [dbo].[Users] WHERE name = 'O''Brien' AND dir = 'C:\\\\data';",
                "WITH c AS (SELECT id FROM #temp WHERE x = '1') SELECT * FROM c",
                "SELECT 'DROP TABLE x; SHUTDOWN' AS msg"
            }) ValidateSourceQuery(allowedSql);
            foreach (string blockedSql in new[]
            {
                "SELECT 1; DROP TABLE t",
                "SELECT 1\nSHUTDOWN WITH NOWAIT",
                "SELECT 1\nDBCC FREEPROCCACHE",
                "SELECT 1\nBACKUP DATABASE [db] TO DISK='NUL'",
                "SELECT 1\nRESTORE DATABASE [db] FROM DISK='NUL'",
                "SELECT 1\nKILL 55",
                "SELECT 1\nRECONFIGURE WITH OVERRIDE",
                @"SELECT '\''; DROP TABLE t -- '",
                @"SELECT E'\''; DROP TABLE t -- '",
                "SELECT 1 /*! INTO OUTFILE '/tmp/x' */",
                "SELECT 1 /*! ; DROP TABLE t */",
                "SELECT 1 # '\n; DROP TABLE t -- '",
                "SELECT $$ ' $$; DROP TABLE t -- '",
                "SELECT 1 /* /* nested */ ; DROP TABLE t */",
                "SELECT 'unterminated"
            })
            {
                bool blocked = false;
                try { ValidateSourceQuery(blockedSql); } catch (Exception) { blocked = true; }
                if (!blocked) throw new Exception($"ValidateSourceQuery failed to reject: {blockedSql}");
            }

            // Test 11: ExcelText & WriteWorkbook safely handle valid surrogate pairs and unpaired UTF-16 surrogates.
            string surrogateWorkbook = Path.Combine(directory, "surrogates.xlsx");
            WriteWorkbook(surrogateWorkbook, ["Col"], [new string?[] { "emoji 😀 lone:\uD800:\uDC00:\uD83D" }]);
            var surrogateRow = FileRows(surrogateWorkbook, out _).Single();
            if (surrogateRow[0]?.ToString()?.Contains("😀", StringComparison.Ordinal) != true)
                throw new Exception("Excel export did not preserve valid UTF-16 surrogate pairs.");

            // Test 12: ConvertCell & ParseSqlDbType edge cases.
            var localDt = new DateTime(2025, 1, 2, 3, 4, 5, DateTimeKind.Local);
            if (ConvertCell(localDt, "datetimeoffset") is not DateTimeOffset dto || dto != new DateTimeOffset(localDt))
                throw new Exception("Local DateTime did not convert to DateTimeOffset.");
            if (ConvertCell(1e30, "decimal").ToString() != "1000000000000000000000000000000")
                throw new Exception("Large double failed decimal(38) conversion.");
            if (ConvertCell("1e5", "decimal").ToString() != "100000" || ConvertCell("-1.25E-2", "decimal").ToString() != "-0.0125")
                throw new Exception("Scientific notation failed decimal conversion.");
            if (ConvertCell("0X00AB", "varbinary") is not byte[] upperHex || !upperHex.SequenceEqual(new byte[] { 0, 171 }))
                throw new Exception("Uppercase 0X binary conversion failed.");
            if (ConvertCell("0x0001", "timestamp") is not byte[] ts || !ts.SequenceEqual(new byte[] { 0, 1 }))
                throw new Exception("Timestamp binary conversion failed.");
            if (ParseSqlDbType("numeric") != SqlDbType.Decimal || ParseSqlDbType("rowversion") != SqlDbType.Timestamp)
                throw new Exception("SQL parameter type alias mapping failed.");
            if (!Equals(ConvertCell("12.50", "money"), 12.50m))
                throw new Exception("Valid money conversion failed.");
            bool commaMoneyRejected = false;
            try { ConvertCell("12,50", "money"); } catch (FormatException) { commaMoneyRejected = true; }
            if (!commaMoneyRejected) throw new Exception("Money conversion silently accepted thousands/comma separator.");

            // Test 13: Non-UTF-8 (Windows-1252) CSV is rejected instead of silently producing U+FFFD.
            string win1252Csv = Path.Combine(directory, "win1252.csv");
            File.WriteAllBytes(win1252Csv, Encoding.GetEncoding(1252).GetBytes("Name,City\r\nCaffè,München\r\n"));
            bool invalidUtf8Rejected = false;
            try { foreach (var _ in FileRows(win1252Csv, out _)) { } }
            catch (DecoderFallbackException) { invalidUtf8Rejected = true; }
            if (!invalidUtf8Rejected) throw new Exception("Invalid UTF-8 CSV was silently accepted with replacement characters.");

            // Test 14: .xlsm and lowercase XLSX CellReference preserve empty string "" (not NULL).
            void CreateEmptyCellWorkbook(string file, SpreadsheetDocumentType docType, string colARef, string colBRef, string row2ARef, string row2BRef)
            {
                using var doc = SpreadsheetDocument.Create(file, docType);
                var wb = doc.AddWorkbookPart(); wb.Workbook = new Workbook();
                var ws = wb.AddNewPart<WorksheetPart>();
                var sd = new SheetData();
                sd.Append(new Row(
                    new Cell(new InlineString(new Text("Id"))) { DataType = CellValues.InlineString, CellReference = colARef },
                    new Cell(new InlineString(new Text("Note"))) { DataType = CellValues.InlineString, CellReference = colBRef }
                ) { RowIndex = 1 });
                sd.Append(new Row(
                    new Cell(new InlineString(new Text("1"))) { DataType = CellValues.InlineString, CellReference = row2ARef },
                    new Cell(new InlineString(new Text(""))) { DataType = CellValues.InlineString, CellReference = row2BRef }
                ) { RowIndex = 2 });
                ws.Worksheet = new Worksheet(sd);
                wb.Workbook.Append(new Sheets(new Sheet { Id = wb.GetIdOfPart(ws), SheetId = 1, Name = "Data" }));
                wb.Workbook.Save();
            }
            string lowerXlsx = Path.Combine(directory, "lower.xlsx"), emptyXlsm = Path.Combine(directory, "empty.xlsm");
            CreateEmptyCellWorkbook(lowerXlsx, SpreadsheetDocumentType.Workbook, "a1", "b1", "a2", "b2");
            CreateEmptyCellWorkbook(emptyXlsm, SpreadsheetDocumentType.MacroEnabledWorkbook, "A1", "B1", "A2", "B2");
            if (!Equals(FileRows(lowerXlsx, out _).Single()[1], "")) throw new Exception("Lowercase XLSX CellReference lost empty string.");
            if (!Equals(FileRows(emptyXlsm, out _).Single()[1], "")) throw new Exception(".xlsm workbook lost empty string.");

            // Test 15: CSV rejects trailing characters after closing quote and invalid delimiters (", \r, \n).
            string badQuoteCsv = Path.Combine(directory, "badquote.csv");
            File.WriteAllText(badQuoteCsv, "a,b\n\"hello\"world,2\n", new UTF8Encoding(false));
            bool badQuoteRejected = false;
            try { foreach (var _ in FileRows(badQuoteCsv, out _)) { } }
            catch (InvalidDataException) { badQuoteRejected = true; }
            if (!badQuoteRejected) throw new Exception("CSV accepted trailing characters after a closing quote.");
            foreach (string badDelim in new[] { "\"", "\n", "\r" })
            {
                Args = new JsonObject { ["delimiter"] = badDelim };
                bool badDelimRejected = false;
                try { FileRows(path, out _); } catch (Exception) { badDelimRejected = true; }
                if (!badDelimRejected) throw new Exception("CSV accepted quote or line break as delimiter.");
            }
            Args = new JsonObject { ["backslashEscaping"] = true };

            // Test 16: Azure ARM resource ID validation rejects #, traversal, non-SQL paths, and case-insensitive same-DB restore.
            string validDb = "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Sql/servers/srv/databases/mydb";
            if (!IsValidAzureSqlResourceId(validDb, true) || !IsValidAzureSqlResourceId("/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Sql/servers/srv", false))
                throw new Exception("Valid Azure SQL resource ID was rejected.");
            foreach (string badId in new[]
            {
                validDb + "#",
                validDb + "%2f..%2fother",
                validDb + "\\..\\other",
                "/subscriptions/sub1/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/x"
            }) if (IsValidAzureSqlResourceId(badId, false)) throw new Exception($"Invalid Azure resource ID accepted: {badId}");
            bool sameDbRejected = false;
            try { ValidateAzureRestoreTarget(validDb, validDb.Replace("mydb", "MYDB")); } catch (Exception) { sameDbRejected = true; }
            if (!sameDbRejected) throw new Exception("Azure restore accepted case-variant of source database ID.");

            // Test 17: Secret redaction, UseEntra consistency, and non-empty schema fallback.
            Password = "My;Pass\"Word'123";
            LastAccessToken = "eyJ.secret.token";
            Args = new JsonObject { ["backupPassword"] = "PfxBackupSecret99!", ["sourceConnection"] = "Driver={SQL Server};Pwd=OdbcSecret77!;Server=x", ["entra"] = true, ["schema"] = "" };
            Connection = new JsonObject { ["authentication"] = new JsonObject { ["kind"] = "sql" } };
            string sampleErr = "cs=\"My;Pass\"\"Word'123\" raw=My;Pass\"Word'123 pfx=PfxBackupSecret99! odbc=OdbcSecret77! tok=eyJ.secret.token";
            string cleaned = RedactSecrets(sampleErr);
            if (cleaned.Contains("Word", StringComparison.Ordinal) || cleaned.Contains("PfxBackup", StringComparison.Ordinal) || cleaned.Contains("OdbcSecret", StringComparison.Ordinal) || cleaned.Contains("eyJ.secret", StringComparison.Ordinal))
                throw new Exception("Secret redaction missed one or more secrets: " + cleaned);
            if (!UseEntra() || SNonEmpty("schema", "dbo") != "dbo")
                throw new Exception("UseEntra or SNonEmpty fallback failed.");
            Password = null; LastAccessToken = null; Args = new(); Connection = new();

            Emit(new { type = "result", value = new { tests = 17, status = "passed" } });
        }
        finally
        {
            if (Path.GetFullPath(directory).StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) Directory.Delete(directory, true);
        }
    }

    private static SqlConnectionStringBuilder Builder(bool encrypted = false)
    {
        var cs = new SqlConnectionStringBuilder
        {
            DataSource = Connection["server"]!.GetValue<string>(),
            InitialCatalog = Connection["defaultDatabase"]?.GetValue<string>() ?? "master",
            ApplicationName = "Quervio - Microsoft",
            ConnectTimeout = 20,
            TrustServerCertificate = Connection["trustServerCertificate"]?.GetValue<bool>() ?? false,
            Encrypt = SqlConnectionEncryptOption.Parse(Connection["encrypt"]?.GetValue<string>() ?? "Mandatory"),
            ColumnEncryptionSetting = encrypted ? SqlConnectionColumnEncryptionSetting.Enabled : SqlConnectionColumnEncryptionSetting.Disabled,
        };
        var authentication = Connection["authentication"]!.AsObject();
        if (authentication["kind"]!.GetValue<string>() == "windows") cs.IntegratedSecurity = true;
        else { cs.UserID = authentication["userName"]?.GetValue<string>() ?? ""; cs.Password = Password ?? ""; }
        if (UseEntra()) { cs.IntegratedSecurity = false; cs.Remove("User ID"); cs.Remove("Password"); }
        return cs;
    }

    private static async Task<SqlConnection> Open(bool encrypted = false)
    {
        var connection = new SqlConnection(Builder(encrypted).ConnectionString);
        try
        {
            if (UseEntra()) connection.AccessToken = (await Token("https://database.windows.net/.default")).Token;
            await connection.OpenAsync(); return connection;
        }
        catch { await connection.DisposeAsync(); throw; }
    }

    private static async Task<object> Script()
    {
        await using var connection = await Open();
        var server = new Server(new ServerConnection(connection));
        var database = server.Databases[connection.Database] ?? throw new Exception("Database not found.");
        // One query per collection instead of one per object.
        server.SetDefaultInitFields(typeof(Table), "IsSystemObject");
        server.SetDefaultInitFields(typeof(Microsoft.SqlServer.Management.Smo.View), "IsSystemObject");
        server.SetDefaultInitFields(typeof(StoredProcedure), "IsSystemObject");
        server.SetDefaultInitFields(typeof(UserDefinedFunction), "IsSystemObject");
        var scripter = new Scripter(server);
        scripter.Options.ScriptSchema = S("mode", "schema") != "data";
        scripter.Options.ScriptData = S("mode") == "data" || S("mode") == "both";
        scripter.Options.DriAll = true; scripter.Options.Indexes = true; scripter.Options.Triggers = true;
        scripter.Options.SchemaQualify = true; scripter.Options.IncludeDatabaseContext = false;
        scripter.Options.WithDependencies = B("dependencies", true);
        scripter.Options.ScriptBatchTerminator = true;
        scripter.Options.TargetServerVersion = (SqlServerVersion)Enum.Parse(typeof(SqlServerVersion), "Version" + I("targetVersion", server.VersionMajor) * 10);
        var names = Args["objects"]?.AsArray().Select(o => o!.GetValue<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var urns = new List<Urn>();
        var schemas = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        bool Include(string schema, string name) { bool included = names is null || names.Count == 0 || names.Contains(schema + "." + name); if (included) schemas.Add(schema); return included; }
        foreach (Table t in database.Tables) if (!t.IsSystemObject && Include(t.Schema, t.Name)) urns.Add(t.Urn);
        if (scripter.Options.ScriptSchema)
        {
            foreach (Microsoft.SqlServer.Management.Smo.View v in database.Views) if (!v.IsSystemObject && Include(v.Schema, v.Name)) urns.Add(v.Urn);
            foreach (StoredProcedure p in database.StoredProcedures) if (!p.IsSystemObject && Include(p.Schema, p.Name)) urns.Add(p.Urn);
            foreach (UserDefinedFunction f in database.UserDefinedFunctions) if (!f.IsSystemObject && Include(f.Schema, f.Name)) urns.Add(f.Urn);
            foreach (DatabaseDdlTrigger trigger in database.Triggers) if (names is null || names.Count == 0 || names.Contains(trigger.Name)) urns.Add(trigger.Urn);
        }
        // SMO scripts objects but not the schemas that hold them.
        IEnumerable<string> Statements()
        {
            if (scripter.Options.ScriptSchema)
                foreach (string schema in schemas.Where(name => !name.Equals("dbo", StringComparison.OrdinalIgnoreCase)))
                    yield return $"IF SCHEMA_ID({L(schema)}) IS NULL EXEC(N'CREATE SCHEMA {Q(schema).Replace("'", "''")}');";
            foreach (string statement in scripter.EnumScript(urns.ToArray())) yield return statement;
        }
        string? path = Args["path"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(path))
        {
            string temp = path + ".quervio-partial-" + Guid.NewGuid().ToString("N");
            try { await using (var writer = new StreamWriter(temp, false, new UTF8Encoding(true))) { foreach (string statement in Statements()) { await writer.WriteLineAsync(statement); await writer.WriteLineAsync("GO"); } } File.Move(temp, path, true); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
            return new { path, objects = urns.Count };
        }
        var text = new StringBuilder(); foreach (string statement in Statements()) { text.AppendLine(statement); text.AppendLine("GO"); if (text.Length > 16 * 1024 * 1024) throw new Exception("Script exceeds 16 MB. Choose a file destination."); }
        return new { script = text.ToString(), objects = urns.Count };
    }

    private static async Task<object> Dac(string action)
    {
        await using var connection = await Open();
        // An open connection's ConnectionString no longer holds the password.
        var service = UseEntra() ? new DacServices(Builder().ConnectionString, new SqlTokenProvider()) : new DacServices(Builder().ConnectionString);
        service.Message += (s, e) => Progress(e.Message.Message);
        service.ProgressChanged += (s, e) => Progress(e.Status + ": " + e.Message);
        string database = connection.Database, path = S("path");
        // Packages are written beside the destination and moved into place, so an
        // interrupted export never leaves a broken package under the chosen name.
        void Package(Action<string> write)
        {
            string temp = path + ".quervio-partial-" + Guid.NewGuid().ToString("N") + Path.GetExtension(path);
            try { write(temp); File.Move(temp, path, true); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        if (action == "extract") { Package(temp => service.Extract(temp, database, "Quervio", new Version(1, 0))); return new { path }; }
        if (action == "bacpacExport") { Package(temp => service.ExportBacpac(temp, database)); return new { path }; }
        if (action == "bacpacImport") { string target = S("targetDatabase") is { Length: > 0 } named ? named : database; using var bac = BacPackage.Load(path); service.ImportBacpac(bac, target); return new { database = target }; }
        using var snapshot = await DacSnapshot.Load(path, action == "dacPreview" ? null : S("packageHash"));
        var package = snapshot.Package;
        var options = new DacDeployOptions { BlockOnPossibleDataLoss = true, DropObjectsNotInSource = B("dropMissing"), CreateNewDatabase = false };
        if (action == "dacPreview") return new { script = service.GenerateDeployScript(package, database, options), report = service.GenerateDeployReport(package, database, options), packageHash = snapshot.Hash };
        service.Deploy(package, database, true, options); return new { database };
    }

    // The digest and DacFx must consume one private, read-only byte snapshot.
    // Never reopen the publisher-controlled pathname after checking approval.
    private sealed class DacSnapshot : IDisposable
    {
        private readonly MemoryStream stream;
        public DacPackage Package { get; }
        public string Hash { get; }

        private DacSnapshot(byte[] bytes, string? approvedHash)
        {
            Hash = Convert.ToHexString(SHA256.HashData(bytes));
            if (approvedHash is not null && approvedHash != Hash)
                throw new InvalidOperationException("The package changed. Generate and approve a new preview.");
            stream = new MemoryStream(bytes, writable: false);
            try { Package = DacPackage.Load(stream, DacSchemaModelStorageType.Memory, FileAccess.Read); }
            catch { stream.Dispose(); throw; }
        }

        public static async Task<DacSnapshot> Load(string path, string? approvedHash = null) =>
            new(await File.ReadAllBytesAsync(path), approvedHash);

        public void Dispose()
        {
            try { Package.Dispose(); }
            finally { stream.Dispose(); }
        }
    }

    private sealed class SqlTokenProvider : IUniversalAuthProvider
    {
        public string GetValidAccessToken() => Token("https://database.windows.net/.default").GetAwaiter().GetResult().Token;
    }

    private static IEnumerable<object?[]> FileRows(string path, out string[] columns)
    {
        if (Path.GetExtension(path).Equals(".csv", StringComparison.OrdinalIgnoreCase))
        {
            string delimiter = S("delimiter", ",");
            if (delimiter.Length != 1 || delimiter[0] is '"' or '\r' or '\n') throw new Exception("The CSV delimiter must be a single character other than a quote or line break.");
            var text = new StreamReader(path, new UTF8Encoding(false, throwOnInvalidBytes: true), true);
            var records = CsvRecords(text, delimiter[0]).GetEnumerator();
            try
            {
                if (!records.MoveNext()) throw new Exception("Missing CSV header.");
                columns = records.Current;
            }
            catch { records.Dispose(); text.Dispose(); throw; }
            return ReadCsv(text, records);
        }
        var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        ExcelDataReader.IExcelDataReader reader;
        try { reader = ExcelDataReader.ExcelReaderFactory.CreateReader(stream); }
        catch { stream.Dispose(); throw; }
        int sheet = I("sheet"); while (sheet-- > 0) if (!reader.NextResult()) { reader.Dispose(); throw new Exception("Worksheet not found."); }
        if (!reader.Read()) { reader.Dispose(); throw new Exception("Missing worksheet header."); }
        columns = Enumerable.Range(0, reader.FieldCount).Select(i => Convert.ToString(reader.GetValue(i), Invariant) ?? "").ToArray();
        string extension = Path.GetExtension(path);
        return extension.Equals(".xlsx", StringComparison.OrdinalIgnoreCase) || extension.Equals(".xlsm", StringComparison.OrdinalIgnoreCase)
            ? ReadExactExcel(path, reader)
            : ReadExcel(reader);
    }
    private static IEnumerable<object?[]> ReadCsv(StreamReader reader, IEnumerator<string[]> records)
    {
        using (reader) using (records) while (records.MoveNext())
            yield return records.Current.Select(v => (object?)(v == S("nullToken", @"\N") ? null : B("backslashEscaping") && v.StartsWith(@"\\", StringComparison.Ordinal) ? v[1..] : v)).ToArray();
    }
    /// <summary>RFC 4180 records: quoted fields keep delimiters, quotes and line breaks, blank lines included.</summary>
    private static IEnumerable<string[]> CsvRecords(TextReader reader, char delimiter)
    {
        var fields = new List<string>(); var field = new StringBuilder(); bool quoted = false, afterQuote = false, any = false;
        int c;
        while ((c = reader.Read()) != -1)
        {
            char ch = (char)c;
            if (quoted)
            {
                if (ch == '"') { if (reader.Peek() == '"') { reader.Read(); field.Append('"'); } else { quoted = false; afterQuote = true; } }
                else field.Append(ch);
                continue;
            }
            if (ch == delimiter) { fields.Add(field.ToString()); field.Clear(); any = true; afterQuote = false; }
            else if (ch == '\r' || ch == '\n')
            {
                if (ch == '\r' && reader.Peek() == '\n') reader.Read();
                // A line with nothing on it is not a record.
                if (any) { fields.Add(field.ToString()); yield return fields.ToArray(); }
                fields.Clear(); field.Clear(); any = false; afterQuote = false;
            }
            else if (afterQuote) throw new InvalidDataException("Unexpected character after a closing quote in CSV.");
            else if (ch == '"' && field.Length == 0) { quoted = true; any = true; }
            else { field.Append(ch); any = true; }
        }
        if (quoted) throw new InvalidDataException("The CSV file ends inside a quoted value.");
        if (any) { fields.Add(field.ToString()); yield return fields.ToArray(); }
    }
    private static IEnumerable<object?[]> ReadExcel(ExcelDataReader.IExcelDataReader reader)
    {
        using (reader) while (reader.Read()) yield return Enumerable.Range(0, reader.FieldCount).Select(i => reader.GetValue(i)).ToArray();
    }

    private static IEnumerable<(int Row, HashSet<int> Columns)> EmptyTextCells(string path)
    {
        using var document = SpreadsheetDocument.Open(path, false);
        var book = document.WorkbookPart ?? throw new Exception("Workbook is missing.");
        var emptySharedStrings = new HashSet<int>();
        if (book.SharedStringTablePart is not null)
        {
            using var strings = OpenXmlReader.Create(book.SharedStringTablePart); int index = 0;
            while (strings.Read()) if (strings.IsStartElement && strings.ElementType == typeof(SharedStringItem)) { var value = strings.LoadCurrentElement(); if (value?.InnerText.Length == 0) emptySharedStrings.Add(index); index++; }
        }
        var sheet = book.Workbook.Sheets?.Elements<Sheet>().ElementAtOrDefault(I("sheet")) ?? throw new Exception("Worksheet not found.");
        var part = (WorksheetPart)book.GetPartById(sheet.Id!.Value!);
        using var xml = OpenXmlReader.Create(part); int previous = 0;
        while (xml.Read())
        {
            if (!xml.IsStartElement || xml.ElementType != typeof(Row)) continue;
            var row = xml.LoadCurrentElement() as Row ?? throw new InvalidDataException("Invalid worksheet row."); int rowNumber = (int)(row.RowIndex?.Value ?? (uint)(previous + 1)); previous = rowNumber;
            var columns = new HashSet<int>(); int column = 0;
            foreach (var cell in row.Elements<Cell>())
            {
                if (cell.CellReference?.Value is string reference)
                {
                    int parsed = 0; bool hasLetters = false;
                    foreach (char raw in reference)
                    {
                        char c = char.ToUpperInvariant(raw);
                        if (c < 'A' || c > 'Z') break;
                        parsed = parsed * 26 + (c - 'A' + 1); hasLetters = true;
                    }
                    if (hasLetters) column = parsed - 1;
                }
                bool empty = cell.DataType?.Value == CellValues.InlineString && (cell.InlineString?.InnerText.Length ?? 0) == 0 || cell.DataType?.Value == CellValues.String && (cell.CellValue?.Text.Length ?? 0) == 0 || cell.DataType?.Value == CellValues.SharedString && int.TryParse(cell.CellValue?.Text, out int shared) && emptySharedStrings.Contains(shared);
                if (empty) columns.Add(column); column++;
            }
            if (columns.Count > 0) yield return (rowNumber, columns);
        }
    }

    private static IEnumerable<object?[]> ReadExactExcel(string path, ExcelDataReader.IExcelDataReader reader)
    {
        using (reader)
        {
            using var empty = EmptyTextCells(path).GetEnumerator(); bool pending = empty.MoveNext();
            while (reader.Read())
            {
                int rowNumber = reader.Depth + 1;
                while (pending && empty.Current.Row < rowNumber) pending = empty.MoveNext();
                var values = Enumerable.Range(0, reader.FieldCount).Select(i => reader.GetValue(i)).ToArray();
                if (pending && empty.Current.Row == rowNumber) foreach (int index in empty.Current.Columns) if (index >= 0 && index < values.Length && values[index] is null) values[index] = "";
                yield return values;
            }
        }
    }
    private static async Task<object> PreviewImport()
    {
        if (S("source") == "odbc")
        {
            ValidateSourceQuery(S("sourceQuery"));
            await using var source = new System.Data.Odbc.OdbcConnection(S("sourceConnection")); await source.OpenAsync();
            await using var command = source.CreateCommand(); command.CommandText = S("sourceQuery"); command.CommandTimeout = 30;
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SingleResult);
            var rows = new List<string?[]>(); while (rows.Count < 20 && await reader.ReadAsync()) rows.Add(Enumerable.Range(0, reader.FieldCount).Select(i => OdbcValue(reader, i) switch { null => null, byte[] b => "0x" + Convert.ToHexString(b), var v => Convert.ToString(v, Invariant) }).ToArray());
            return new { columns = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray(), rows };
        }
        var data = FileRows(S("path"), out var columns);
        return new { columns, rows = data.Take(20).Select(r => r.Select(v => v is null ? null : Convert.ToString(v, Invariant)).ToArray()).ToArray() };
    }

    private static async Task<object> Import()
    {
        await using var connection = await Open();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();
        string target = Q(SNonEmpty("schema", "dbo")) + "." + Q(S("table"));
        try
        {
            var metadata = new Dictionary<string, (string Name, string Type, int Length)>(StringComparer.OrdinalIgnoreCase);
            // CLR types (hierarchyid, geometry, geography) share system type 240; alias types resolve to their base type.
            // system_type_id 189 is timestamp/rowversion, which is server-generated and not writable.
            await using (var command = new SqlCommand("SELECT c.name,CASE WHEN c.system_type_id=240 THEN TYPE_NAME(c.user_type_id) ELSE TYPE_NAME(c.system_type_id) END,c.max_length FROM sys.columns c WHERE c.object_id=OBJECT_ID(@target) AND c.is_computed=0 AND c.generated_always_type=0 AND c.system_type_id<>189", connection, transaction))
            {
                // generated_always_type does not exist on SQL Server 2012/2014.
                if (int.Parse(connection.ServerVersion.Split('.')[0]) < 13) command.CommandText = command.CommandText.Replace(" AND c.generated_always_type=0", "");
                command.Parameters.AddWithValue("@target", target);
                await using var reader = await command.ExecuteReaderAsync(); while (await reader.ReadAsync()) metadata.Add(reader.GetString(0), (reader.GetString(0), reader.GetString(1), reader.GetInt16(2)));
            }
            if (metadata.Count == 0) throw new Exception("Destination table not found or no writable columns.");
            using var bulk = new SqlBulkCopy(connection, SqlBulkCopyOptions.CheckConstraints | (B("keepIdentity") ? SqlBulkCopyOptions.KeepIdentity : 0), transaction) { DestinationTableName = target, BatchSize = 2000, BulkCopyTimeout = I("timeout", 0) };
            var mapping = Args["mapping"]?.AsObject() ?? new();
            long count = 0;
            async Task Transfer(string[] headers, IEnumerable<object?[]> rows)
            {
                foreach (var (source, value) in mapping)
                {
                    string? wanted = value?.GetValue<string>();
                    if (!string.IsNullOrEmpty(wanted) && !metadata.ContainsKey(wanted)) throw new Exception($"Source column '{source}' is mapped to '{wanted}', which is not a writable column of {target}.");
                }
                var columns = headers.Select((name, index) => new { Index = index, Source = name, Target = mapping[name]?.GetValue<string>() ?? name })
                    .Where(c => metadata.ContainsKey(c.Target)).Select(c => new { c.Index, c.Source, Column = metadata[c.Target] }).ToArray();
                if (columns.Length == 0) throw new Exception("No source columns map to destination columns.");
                foreach (var c in columns) if (c.Column.Type is "hierarchyid" or "geometry" or "geography") throw new Exception($"Column {c.Column.Name} has type {c.Column.Type}, which import does not convert. Ignore it in the mapping or import into a staging table.");
                // Bulk copy matches column names exactly, so it gets the names as the table stores them.
                var batch = new DataTable(); foreach (var c in columns) { batch.Columns.Add(c.Column.Name, CellType(c.Column.Type)); bulk.ColumnMappings.Add(c.Column.Name, c.Column.Name); }
                // Rows are numbered from the file's first line, the header.
                long first = count + 2;
                async Task Flush() { try { await bulk.WriteToServerAsync(batch); } catch (Exception e) { throw new Exception($"Source rows {first}-{count + 1}: {e.Message}", e); } batch.Clear(); first = count + 2; }
                foreach (var row in rows)
                {
                    long line = count + 2;
                    if (row.Length != headers.Length) throw new Exception($"Source row {line} has {row.Length} fields; expected {headers.Length}.");
                    var values = new object[columns.Length];
                    for (int i = 0; i < columns.Length; i++)
                    {
                        var c = columns[i];
                        try { values[i] = ConvertCell(row[c.Index], c.Column.Type); }
                        catch (Exception e) { throw new Exception($"Source row {line}, column {c.Source}: {e.Message}", e); }
                        int limit = c.Column.Length == -1 ? -1 : c.Column.Type is "nchar" or "nvarchar" ? c.Column.Length / 2 : c.Column.Type is "char" or "varchar" or "binary" or "varbinary" ? c.Column.Length : -1;
                        int length = values[i] switch { string text => text.Length, byte[] bytes => bytes.Length, _ => 0 };
                        if (limit >= 0 && length > limit) throw new Exception($"Source row {line}, column {c.Source}: {length} characters, but {c.Column.Name} holds {limit}.");
                    }
                    batch.Rows.Add(values); count++;
                    if (batch.Rows.Count >= 2000) { await Flush(); Progress("Importing inside one transaction", count); }
                }
                if (batch.Rows.Count > 0) await Flush();
            }
            if (S("source") == "odbc")
            {
                ValidateSourceQuery(S("sourceQuery"));
                await using var source = new System.Data.Odbc.OdbcConnection(S("sourceConnection")); await source.OpenAsync();
                await using var command = source.CreateCommand(); command.CommandText = S("sourceQuery"); command.CommandTimeout = 0;
                using var reader = command.ExecuteReader();
                IEnumerable<object?[]> Rows() { while (reader.Read()) yield return Enumerable.Range(0, reader.FieldCount).Select(i => OdbcValue(reader, i)).ToArray(); }
                await Transfer(Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray(), Rows());
            }
            else { var rows = FileRows(S("path"), out var headers); await Transfer(headers, rows); }
            await transaction.CommitAsync(); return new { rows = count, transaction = "committed" };
        }
        catch { try { await transaction.RollbackAsync(); } catch (Exception) { } throw; }
    }

    // decimal(38) does not fit System.Decimal, and OdbcDataReader.IsDBNull reads the value
    // as one: read decimals as text, where NULL shows as InvalidCastException.
    private static object? OdbcValue(System.Data.Common.DbDataReader reader, int i)
    {
        if (reader.GetFieldType(i) != typeof(decimal)) return reader.IsDBNull(i) ? null : reader.GetValue(i);
        try { return reader.GetString(i); }
        catch (InvalidCastException)
        {
            if (reader.IsDBNull(i)) return null;
            return reader.GetDecimal(i).ToString(Invariant);
        }
    }

    private static SqlDecimal ParseSqlDecimal(string text)
    {
        string trimmed = text.Trim();
        int expIndex = trimmed.IndexOfAny(['e', 'E']);
        if (expIndex < 0) return SqlDecimal.Parse(trimmed);
        if (trimmed.IndexOfAny(['e', 'E'], expIndex + 1) >= 0) throw new FormatException("Invalid decimal value.");
        string mantissa = trimmed[..expIndex], exponentText = trimmed[(expIndex + 1)..];
        if (mantissa.Length == 0 || exponentText.Length == 0) throw new FormatException("Invalid decimal value.");
        bool negative = false;
        if (mantissa[0] is '+' or '-') { negative = mantissa[0] == '-'; mantissa = mantissa[1..]; }
        int dot = mantissa.IndexOf('.');
        if (dot >= 0 && mantissa.IndexOf('.', dot + 1) >= 0) throw new FormatException("Invalid decimal value.");
        string intPart = dot >= 0 ? mantissa[..dot] : mantissa;
        string fracPart = dot >= 0 ? mantissa[(dot + 1)..] : "";
        if ((intPart.Length == 0 && fracPart.Length == 0) || !intPart.All(char.IsAsciiDigit) || !fracPart.All(char.IsAsciiDigit))
            throw new FormatException("Invalid decimal value.");
        int exponent = int.Parse(exponentText, NumberStyles.AllowLeadingSign, Invariant);
        string digits = (intPart + fracPart).TrimStart('0');
        if (digits.Length == 0) return new SqlDecimal(0m);
        int leadingZeros = intPart.Length + fracPart.Length - digits.Length;
        int decimalPos = intPart.Length - leadingZeros + exponent;
        digits = digits.TrimEnd('0');
        string fixedPoint;
        if (decimalPos <= 0)
        {
            int pad = -decimalPos;
            if ((long)pad + digits.Length > 38) throw new OverflowException("Decimal value exceeds SQL Server decimal(38) precision.");
            fixedPoint = "0." + new string('0', pad) + digits;
        }
        else if (decimalPos >= digits.Length)
        {
            if (decimalPos > 38) throw new OverflowException("Decimal value exceeds SQL Server decimal(38) precision.");
            fixedPoint = digits + new string('0', decimalPos - digits.Length);
        }
        else
        {
            if (digits.Length > 38) throw new OverflowException("Decimal value exceeds SQL Server decimal(38) precision.");
            fixedPoint = digits[..decimalPos] + "." + digits[decimalPos..];
        }
        return SqlDecimal.Parse(negative ? "-" + fixedPoint : fixedPoint);
    }

    private static object ConvertCell(object? value, string type)
    {
        if (value is null || value is DBNull) return DBNull.Value;
        // Workbooks made in Excel carry numbers, dates and booleans, not text.
        if (value is double number)
        {
            switch (type)
            {
                case "float": return number;
                case "real": return (float)number;
                case "bit": return number != 0;
                case "decimal" or "numeric":
                    if (double.IsNaN(number) || double.IsInfinity(number)) throw new FormatException($"{number.ToString("R", Invariant)} is not a valid decimal.");
                    return Math.Abs(number) < 7.9e28 ? new SqlDecimal((decimal)number) : ParseSqlDecimal(number.ToString("R", Invariant));
                case "money" or "smallmoney": return (decimal)number;
                case "bigint" or "int" or "smallint" or "tinyint":
                    if (number != Math.Floor(number)) throw new FormatException($"{number.ToString("R", Invariant)} is not a whole number.");
                    value = ((decimal)number).ToString(Invariant); break;
                default: value = Math.Abs(number) < 7.9e28 ? ((decimal)number).ToString(Invariant) : number.ToString("R", Invariant); break;
            }
        }
        if (value is bool flag && type != "bit") value = flag ? "1" : "0";
        if (value is DateTime moment)
        {
            if (type == "time") return moment.TimeOfDay;
            if (type == "datetimeoffset") return moment.Kind == DateTimeKind.Unspecified ? new DateTimeOffset(moment, TimeSpan.Zero) : new DateTimeOffset(moment);
            if (type is not ("date" or "datetime" or "datetime2" or "smalldatetime")) value = moment.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", Invariant);
        }
        string text = Convert.ToString(value, Invariant) ?? "";
        return type switch
        {
            "decimal" or "numeric" => ParseSqlDecimal(text),
            "money" or "smallmoney" => decimal.Parse(text, NumberStyles.Float, Invariant),
            "bigint" => long.Parse(text, Invariant),
            "int" => int.Parse(text, Invariant),
            "smallint" => short.Parse(text, Invariant),
            "tinyint" => byte.Parse(text, Invariant),
            "bit" => text == "1" || bool.Parse(text == "0" ? "false" : text),
            "float" => double.Parse(text, Invariant),
            "real" => float.Parse(text, Invariant),
            "date" or "datetime" or "datetime2" or "smalldatetime" => value is DateTime date ? date : DateTime.Parse(text, Invariant, DateTimeStyles.RoundtripKind),
            "datetimeoffset" => DateTimeOffset.Parse(text, Invariant, DateTimeStyles.RoundtripKind),
            "time" => TimeSpan.Parse(text, Invariant),
            "uniqueidentifier" => Guid.Parse(text),
            "binary" or "varbinary" or "image" or "timestamp" or "rowversion" => value is byte[] bytes ? bytes : Convert.FromHexString(text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text),
            _ => text
        };
    }

    private static string StripSqlTokens(string sql, bool hashStartsComment)
    {
        const string rejected = "The ODBC source must be one SELECT query; preview and import do not execute source writes.";
        var output = new StringBuilder(sql.Length);
        int i = 0;
        while (i < sql.Length)
        {
            char ch = sql[i];
            if (ch is '\'' or '"')
            {
                char quote = ch; i++; int slashes = 0; bool closed = false;
                while (i < sql.Length)
                {
                    char c = sql[i++];
                    if (c == quote)
                    {
                        if ((slashes & 1) == 1) throw new Exception(rejected);
                        if (i < sql.Length && sql[i] == quote) { i++; slashes = 0; continue; }
                        closed = true; break;
                    }
                    slashes = c == '\\' ? slashes + 1 : 0;
                }
                if (!closed) throw new Exception(rejected);
                output.Append(' ');
                continue;
            }
            if (ch == '[')
            {
                i++; bool closed = false;
                while (i < sql.Length)
                {
                    char c = sql[i++];
                    if (c == ']')
                    {
                        if (i < sql.Length && sql[i] == ']') { i++; continue; }
                        closed = true; break;
                    }
                }
                if (!closed) throw new Exception(rejected);
                output.Append(' ');
                continue;
            }
            if (ch == '`')
            {
                i++; bool closed = false;
                while (i < sql.Length)
                {
                    char c = sql[i++];
                    if (c == '`')
                    {
                        if (i < sql.Length && sql[i] == '`') { i++; continue; }
                        closed = true; break;
                    }
                }
                if (!closed) throw new Exception(rejected);
                output.Append(' ');
                continue;
            }
            if (ch == '$')
            {
                int end = i + 1;
                if (end < sql.Length && (sql[end] == '$' || char.IsLetter(sql[end]) || sql[end] == '_'))
                {
                    if (sql[end] != '$') while (end < sql.Length && (char.IsLetterOrDigit(sql[end]) || sql[end] == '_')) end++;
                    if (end < sql.Length && sql[end] == '$')
                    {
                        string tag = sql[i..(end + 1)];
                        int close = sql.IndexOf(tag, end + 1, StringComparison.Ordinal);
                        if (close < 0) throw new Exception(rejected);
                        i = close + tag.Length;
                        output.Append(' ');
                        continue;
                    }
                }
            }
            if (ch == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                i += 2;
                while (i < sql.Length && sql[i] != '\r' && sql[i] != '\n') i++;
                output.Append(' ');
                continue;
            }
            if (hashStartsComment && ch == '#')
            {
                i++;
                while (i < sql.Length && sql[i] != '\r' && sql[i] != '\n') i++;
                output.Append(' ');
                continue;
            }
            if (ch == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                if (i + 2 < sql.Length && sql[i + 2] == '!') throw new Exception(rejected);
                i += 2; bool closed = false;
                while (i + 1 < sql.Length)
                {
                    if (sql[i] == '/' && sql[i + 1] == '*') throw new Exception(rejected);
                    if (sql[i] == '*' && sql[i + 1] == '/') { i += 2; closed = true; break; }
                    i++;
                }
                if (!closed) throw new Exception(rejected);
                output.Append(' ');
                continue;
            }
            output.Append(ch); i++;
        }
        return output.ToString();
    }

    private static void ValidateSourceQuery(string sql)
    {
        const string rejected = "The ODBC source must be one SELECT query; preview and import do not execute source writes.";
        if (string.IsNullOrWhiteSpace(sql)) throw new Exception(rejected);
        void Check(string tokens)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(tokens, @"^\s*(SELECT|WITH)\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                || System.Text.RegularExpressions.Regex.IsMatch(tokens, @"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|CALL|GRANT|DENY|REVOKE|INTO|OUTFILE|DUMPFILE|SHUTDOWN|DBCC|BACKUP|RESTORE|KILL|RECONFIGURE|CHECKPOINT|BULK|OPENROWSET|OPENDATASOURCE|WAITFOR|WRITETEXT|UPDATETEXT|READTEXT|COPY|LOAD|FLUSH|PURGE|ATTACH|DETACH|VACUUM|PRAGMA|RAISERROR|DEALLOCATE|PREPARE|DO|LOCK|UNLOCK|RENAME|REPAIR|OPTIMIZE|INSTALL|UNINSTALL|USE|SET|DECLARE|PRINT|THROW|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|GO)\b|;\s*\S", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new Exception(rejected);
        }
        Check(StripSqlTokens(sql, hashStartsComment: false));
        if (sql.Contains('#')) Check(StripSqlTokens(sql, hashStartsComment: true));
    }

    private static Type CellType(string type) => type switch
    {
        "decimal" or "numeric" => typeof(SqlDecimal),
        "money" or "smallmoney" => typeof(decimal),
        "bigint" => typeof(long),
        "int" => typeof(int),
        "smallint" => typeof(short),
        "tinyint" => typeof(byte),
        "bit" => typeof(bool),
        "float" => typeof(double),
        "real" => typeof(float),
        "date" or "datetime" or "datetime2" or "smalldatetime" => typeof(DateTime),
        "datetimeoffset" => typeof(DateTimeOffset),
        "time" => typeof(TimeSpan),
        "uniqueidentifier" => typeof(Guid),
        "binary" or "varbinary" or "image" or "timestamp" or "rowversion" => typeof(byte[]),
        _ => typeof(string)
    };

    private static string? Exact(SqlDataReader reader, int i)
    {
        if (reader.IsDBNull(i)) return null;
        if (reader.GetDataTypeName(i) is "decimal" or "numeric") return reader.GetSqlDecimal(i).ToString();
        object value = reader.GetValue(i);
        return value switch { byte[] b => "0x" + Convert.ToHexString(b), DateTime date => date.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", Invariant), DateTimeOffset date => date.ToString("O", Invariant), TimeSpan time => time.ToString("c", Invariant), bool bit => bit ? "1" : "0", IFormattable f => f.ToString(null, Invariant), _ => value.ToString() };
    }
    private static bool IsSpreadsheetFormula(string text)
    {
        int first = 0;
        while (first < text.Length && (char.IsWhiteSpace(text[first]) || char.IsControl(text[first]) || text[first] is '\uFEFF' or '\u200B')) first++;
        string value = text[first..];
        if (value.Length == 0) return false;
        if (value[0] is '+' or '-' && value.All(c => char.IsAsciiDigit(c) || ".+-eE".Contains(c)) && double.TryParse(value, NumberStyles.Float, Invariant, out _)) return false;
        return "=+-@＝＋－＠".Contains(value[0]);
    }

    private static string Csv(string? text) => CsvField(text, escapeBackslashes: true);

    private static string CsvField(string? text, bool escapeBackslashes)
    {
        if (text is not null && IsSpreadsheetFormula(text))
            throw new InvalidDataException("CSV contains formula-like text in a value or column name. Export as Excel (.xlsx) to preserve it safely as text.");
        string value = text is null ? @"\N" : escapeBackslashes && text.StartsWith((char)92) ? ((char)92) + text : text;
        return "\"" + value.Replace("\"", "\"\"") + "\"";
    }

    private static async Task<object> Export()
    {
        await using var connection = await Open();
        string path = S("path"), temp = path + ".quervio-partial-" + Guid.NewGuid().ToString("N"); long rows = 0;
        try
        {
            await using var command = new SqlCommand("SELECT * FROM " + Q(SNonEmpty("schema", "dbo")) + "." + Q(S("table")), connection) { CommandTimeout = 0 };
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess);
            if (Path.GetExtension(path).Equals(".xlsx", StringComparison.OrdinalIgnoreCase))
            {
                IEnumerable<string?[]> Rows() { while (reader.Read()) yield return Enumerable.Range(0, reader.FieldCount).Select(i => Exact(reader, i)).ToArray(); }
                rows = WriteWorkbook(temp, Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray(), Rows());
            }
            else
            {
                await using var writer = new StreamWriter(temp, false, new UTF8Encoding(true));
                await writer.WriteLineAsync(string.Join(",", Enumerable.Range(0, reader.FieldCount).Select(i => CsvField(reader.GetName(i), escapeBackslashes: false))));
                while (await reader.ReadAsync()) { await writer.WriteLineAsync(string.Join(",", Enumerable.Range(0, reader.FieldCount).Select(i => Csv(Exact(reader, i))))); rows++; if (rows % 2000 == 0) Progress("Exporting", rows); }
            }
            File.Move(temp, path, true); return new { path, rows, nullToken = @"\N", backslashEscaping = true };
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    private static long WriteWorkbook(string path, string[] headers, IEnumerable<string?[]> records)
    {
        long index = 0;
        using var doc = SpreadsheetDocument.Create(path, SpreadsheetDocumentType.Workbook);
        var workbook = doc.AddWorkbookPart(); workbook.Workbook = new Workbook();
        var worksheet = workbook.AddNewPart<WorksheetPart>();
        using (var writer = OpenXmlWriter.Create(worksheet))
        {
            writer.WriteStartElement(new Worksheet()); writer.WriteStartElement(new SheetData());
            void Row(IEnumerable<string?> cells)
            {
                writer.WriteStartElement(new Row()); int column = 0;
                foreach (var text in cells)
                {
                    column++; string name = ""; int n = column; while (n > 0) { n--; name = (char)('A' + n % 26) + name; n /= 26; }
                    if (text is null) writer.WriteElement(new Cell { CellReference = name + (index + 1) });
                    else
                    {
                        if (text.Length > 32767) throw new Exception($"Row {index}, column {name}: Excel cells hold at most 32,767 characters. Export CSV instead.");
                        writer.WriteElement(new Cell(new InlineString(new Text(ExcelText(text)) { Space = SpaceProcessingModeValues.Preserve })) { DataType = CellValues.InlineString, CellReference = name + (index + 1) });
                    }
                }
                writer.WriteEndElement();
            }
            Row(headers);
            foreach (var record in records) { index++; if (index >= 1048576) throw new Exception("Excel worksheet row limit reached. Export CSV instead."); Row(record); if (index % 2000 == 0) Progress("Exporting exact values as Excel text cells", index); }
            writer.WriteEndElement(); writer.WriteEndElement();
        }
        workbook.Workbook.Append(new Sheets(new Sheet { Id = workbook.GetIdOfPart(worksheet), SheetId = 1, Name = "Data" })); workbook.Workbook.Save();
        return index;
    }

    // Excel stores carriage returns and characters XML cannot hold as _xHHHH_;
    // a literal _xHHHH_ in the text is escaped so reading does not decode it.
    private static string ExcelText(string text)
    {
        var result = new StringBuilder(text.Length);
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) result.Append(c).Append(text[++i]);
                else result.Append("_x").Append(((int)c).ToString("X4", Invariant)).Append('_');
            }
            else if (char.IsLowSurrogate(c)) result.Append("_x").Append(((int)c).ToString("X4", Invariant)).Append('_');
            else if (c == '_' && i + 6 < text.Length && text[i + 1] == 'x' && text[i + 6] == '_' && text.Substring(i + 2, 4).All(Uri.IsHexDigit)) result.Append("_x005F_");
            else if (c < 0x20 && c != '\t' && c != '\n' || c == '\uFFFE' || c == '\uFFFF') result.Append("_x").Append(((int)c).ToString("X4", Invariant)).Append('_');
            else result.Append(c);
        }
        return result.ToString();
    }

    private static SqlDbType ParseSqlDbType(string rawType) => rawType.Trim().ToLowerInvariant() switch
    {
        "numeric" => SqlDbType.Decimal,
        "rowversion" => SqlDbType.Timestamp,
        _ => Enum.Parse<SqlDbType>(rawType, true)
    };

    private static async Task<object> EncryptedQuery()
    {
        await using var connection = await Open(true);
        await using var command = new SqlCommand(S("query"), connection) { CommandTimeout = I("timeout", 30) };
        string rawParameters = S("parametersJson");
        var parameterNodes = Args["parameters"]?.AsArray() ?? JsonNode.Parse(string.IsNullOrWhiteSpace(rawParameters) ? "[]" : rawParameters)!.AsArray();
        foreach (var node in parameterNodes)
        {
            var item = node!.AsObject(); var type = ParseSqlDbType(item["type"]!.GetValue<string>());
            var parameter = command.Parameters.Add(item["name"]!.GetValue<string>(), type);
            if (item["size"] is not null) parameter.Size = item["size"]!.GetValue<int>();
            if (item["precision"] is not null) parameter.Precision = item["precision"]!.GetValue<byte>();
            if (item["scale"] is not null) parameter.Scale = item["scale"]!.GetValue<byte>();
            var value = item["value"];
            parameter.Value = ConvertCell(value is null ? null : value.GetValueKind() == JsonValueKind.String ? value.GetValue<string>() : value.ToJsonString(), type.ToString().ToLowerInvariant());
        }
        var sets = new List<object>(); await using var reader = await command.ExecuteReaderAsync();
        do { if (reader.FieldCount == 0) continue; var columns = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray(); var rows = new List<string?[]>(); bool truncated = false; while (await reader.ReadAsync()) { if (rows.Count >= I("maxRows", 1000)) { truncated = true; break; } rows.Add(Enumerable.Range(0, reader.FieldCount).Select(i => Exact(reader, i)).ToArray()); } sets.Add(new { columns, rows, truncated }); } while (await reader.NextResultAsync());
        return new { sets };
    }

    private static async Task<object> ColumnEncryption()
    {
        string? token = UseEntra() ? (await Token("https://database.windows.net/.default")).Token : null;
        var start = new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe")) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, UseShellExecute = false, CreateNoWindow = true };
        foreach (string argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Path.Combine(AppContext.BaseDirectory, "ColumnEncryption.ps1") }) start.ArgumentList.Add(argument);
        using var process = System.Diagnostics.Process.Start(start) ?? throw new Exception("Could not start the Microsoft column encryption tool.");
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { connectionString = Builder(true).ConnectionString, accessToken = token, schema = SNonEmpty("schema", "dbo"), table = S("table"), column = S("column"), key = S("key"), decrypt = B("decrypt"), encryptionType = SNonEmpty("encryptionType", "Deterministic") }));
        }
        catch (IOException) { }
        finally { try { process.StandardInput.Close(); } catch (IOException) { } }
        await process.WaitForExitAsync(); string output = await stdout; string error = await stderr;
        if (process.ExitCode != 0) throw new Exception(string.IsNullOrWhiteSpace(error) ? output : error);
        return new { message = output.Trim() };
    }

    private static async Task<object> CreateColumnKeys()
    {
        string master = S("masterKey"), key = S("key"), path = S("backupPath"), password = S("backupPassword");
        if (string.IsNullOrWhiteSpace(master) || string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(path) || password.Length < 12) throw new Exception("Provide key names, a new PFX backup path and a password of at least 12 characters.");
        if (File.Exists(path)) throw new Exception("The PFX backup destination already exists.");
        await using var connection = await Open();
        using var rsa = RSA.Create(3072);
        var request = new CertificateRequest("CN=Quervio Always Encrypted", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyEncipherment | X509KeyUsageFlags.DataEncipherment, true));
        using var generated = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(5));
        byte[] pfx = generated.Export(X509ContentType.Pfx, password);
        X509Certificate2 certificate;
        try
        {
            // The backup is created before registering keys in the database.
            using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) await file.WriteAsync(pfx);
            certificate = X509CertificateLoader.LoadPkcs12(pfx, password, X509KeyStorageFlags.PersistKeySet | X509KeyStorageFlags.Exportable | X509KeyStorageFlags.UserKeySet);
        }
        finally { CryptographicOperations.ZeroMemory(pfx); }
        string keyPath;
        using (certificate)
        {
            using (var store = new X509Store(StoreName.My, StoreLocation.CurrentUser)) { store.Open(OpenFlags.ReadWrite); store.Add(certificate); }
            keyPath = "CurrentUser/My/" + certificate.Thumbprint;
        }
        byte[] plain = RandomNumberGenerator.GetBytes(32); byte[] encrypted;
        try { encrypted = new SqlColumnEncryptionCertificateStoreProvider().EncryptColumnEncryptionKey(keyPath, "RSA_OAEP", plain); } finally { CryptographicOperations.ZeroMemory(plain); }
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();
        try
        {
            await using var command = new SqlCommand($"CREATE COLUMN MASTER KEY {Q(master)} WITH(KEY_STORE_PROVIDER_NAME=N'MSSQL_CERTIFICATE_STORE',KEY_PATH={L(keyPath)}); CREATE COLUMN ENCRYPTION KEY {Q(key)} WITH VALUES(COLUMN_MASTER_KEY={Q(master)},ALGORITHM=N'RSA_OAEP',ENCRYPTED_VALUE=0x{Convert.ToHexString(encrypted)});", connection, transaction);
            await command.ExecuteNonQueryAsync();
            await transaction.CommitAsync();
        }
        catch { try { await transaction.RollbackAsync(); } catch (Exception) { } throw; }
        return new { masterKey = master, key, keyPath, backupPath = path };
    }

    private static async Task<object> RotateMasterKey()
    {
        await using var connection = await Open();
        await using var read = new SqlCommand("SELECT TOP(1) v.encrypted_value,m.key_path,newm.key_path FROM sys.column_encryption_keys k JOIN sys.column_encryption_key_values v ON v.column_encryption_key_id=k.column_encryption_key_id JOIN sys.column_master_keys m ON m.column_master_key_id=v.column_master_key_id CROSS JOIN sys.column_master_keys newm WHERE k.name=@key AND newm.name=@master AND m.key_store_provider_name=N'MSSQL_CERTIFICATE_STORE' AND newm.key_store_provider_name=N'MSSQL_CERTIFICATE_STORE'", connection);
        read.Parameters.AddWithValue("@key", S("key")); read.Parameters.AddWithValue("@master", S("masterKey"));
        byte[] encrypted; string oldPath, newPath;
        await using (var reader = await read.ExecuteReaderAsync()) { if (!await reader.ReadAsync()) throw new Exception("Matching certificate-backed keys were not found."); encrypted = (byte[])reader.GetValue(0); oldPath = reader.GetString(1); newPath = reader.GetString(2); }
        var provider = new SqlColumnEncryptionCertificateStoreProvider(); byte[] plain = provider.DecryptColumnEncryptionKey(oldPath, "RSA_OAEP", encrypted); byte[] wrapped;
        try { wrapped = provider.EncryptColumnEncryptionKey(newPath, "RSA_OAEP", plain); } finally { CryptographicOperations.ZeroMemory(plain); }
        await using var command = new SqlCommand($"ALTER COLUMN ENCRYPTION KEY {Q(S("key"))} ADD VALUE(COLUMN_MASTER_KEY={Q(S("masterKey"))},ALGORITHM=N'RSA_OAEP',ENCRYPTED_VALUE=0x{Convert.ToHexString(wrapped)});", connection);
        await command.ExecuteNonQueryAsync(); return new { key = S("key"), masterKey = S("masterKey"), oldProtectorRetained = true };
    }

    private static bool IsValidAzureSqlResourceId(string id, bool requireDatabase)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Contains('?') || id.Contains('#') || id.Contains("..") || id.Contains('\\')
            || id.Any(c => char.IsWhiteSpace(c) || char.IsControl(c))
            || System.Text.RegularExpressions.Regex.IsMatch(id, @"%(?:2e|2f|5c|3f|23)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return false;
        string pattern = requireDatabase
            ? @"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Sql/servers/[^/]+/databases/[^/]+$"
            : @"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.Sql/servers/[^/]+(?:/databases(?:/[^/]+)?)?$";
        return System.Text.RegularExpressions.Regex.IsMatch(id, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    private static void ValidateAzureRestoreTarget(string sourceId, string targetId)
    {
        if (!IsValidAzureSqlResourceId(targetId, requireDatabase: true)
            || string.Equals(targetId.TrimEnd('/'), sourceId.TrimEnd('/'), StringComparison.OrdinalIgnoreCase))
            throw new Exception("Restore requires a different full destination Azure SQL database resource ID.");
    }

    private static async Task<object> Azure(string action)
    {
        string id = S("resourceId");
        bool requireDatabase = action != "azureList";
        if (!IsValidAzureSqlResourceId(id, requireDatabase)) throw new Exception("Use a full Azure SQL resource ID.");
        string target = ""; string restorePointInTime = "";
        if (action == "azureRestore")
        {
            target = S("targetResourceId");
            ValidateAzureRestoreTarget(id, target);
            restorePointInTime = DateTimeOffset.Parse(S("pointInTime"), Invariant).ToString("O");
        }
        using var http = new HttpClient(); http.DefaultRequestHeaders.Authorization = new("Bearer", (await Token("https://management.azure.com/.default")).Token);
        async Task<JsonNode> Send(HttpMethod method, string resource, JsonNode? body = null)
        {
            using var request = new HttpRequestMessage(method, "https://management.azure.com" + resource + "?api-version=2023-08-01");
            if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await http.SendAsync(request); string text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode) throw new Exception($"Azure {response.StatusCode}: {text}");
            return JsonNode.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text)!;
        }
        if (action == "azureList") return await Send(HttpMethod.Get, id);
        if (action == "azureBackups") return new { shortTerm = await Send(HttpMethod.Get, id + "/backupShortTermRetentionPolicies/default"), longTerm = await Send(HttpMethod.Get, id + "/backupLongTermRetentionPolicies/default") };
        if (action == "azureRetention") return await Send(HttpMethod.Put, id + "/backupShortTermRetentionPolicies/default", new JsonObject { ["properties"] = new JsonObject { ["retentionDays"] = I("days", 7) } });
        var source = await Send(HttpMethod.Get, id);
        return await Send(HttpMethod.Put, target, new JsonObject { ["location"] = source["location"]!.DeepClone(), ["properties"] = new JsonObject { ["createMode"] = "PointInTimeRestore", ["sourceDatabaseId"] = id, ["restorePointInTime"] = restorePointInTime } });
    }
}
