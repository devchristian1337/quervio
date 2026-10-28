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
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly string IdentityPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "com.quervio.app", "identity.json");
    private static readonly InteractiveBrowserCredential Credential = CreateCredential();
    private static InteractiveBrowserCredential CreateCredential()
    {
        var options = new InteractiveBrowserCredentialOptions { TokenCachePersistenceOptions = new TokenCachePersistenceOptions { Name = "Quervio", UnsafeAllowUnencryptedStorage = false } };
        try { if (File.Exists(IdentityPath)) { using var stream = File.OpenRead(IdentityPath); options.AuthenticationRecord = AuthenticationRecord.Deserialize(stream); } } catch (Exception) { }
        return new InteractiveBrowserCredential(options);
    }
    private static async Task<AccessToken> Token(string scope)
    {
        var request = new TokenRequestContext([scope]);
        if (!File.Exists(IdentityPath)) { var record = await Credential.AuthenticateAsync(request); Directory.CreateDirectory(Path.GetDirectoryName(IdentityPath)!); using var stream = new FileStream(IdentityPath, FileMode.Create, FileAccess.Write, FileShare.None); record.Serialize(stream); }
        return await Credential.GetTokenAsync(request);
    }
    private static string S(string key, string fallback = "") => Args[key]?.GetValue<string>() ?? fallback;
    private static bool B(string key, bool fallback = false) => Args[key]?.GetValue<bool>() ?? fallback;
    private static int I(string key, int fallback = 0) => Args[key]?.GetValue<int>() ?? fallback;
    private static string Q(string name) => "[" + name.Replace("]", "]]") + "]";
    private static string L(string text) => "N'" + text.Replace("'", "''") + "'";
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
            if (options.Contains("--self-test")) { SelfTest(); return 0; }
            if (options.Contains("--result-export")) { ResultExport(); return 0; }
            if (options.Contains("--version")) { Emit(new { version = "1.0", runtime = Environment.Version.ToString() }); return 0; }
            if (options.Contains("--access-token")) { var token = await Token("https://database.windows.net/.default"); Emit(new { accessToken = token.Token, expiresOn = token.ExpiresOn.ToUnixTimeSeconds() }); return 0; }
            var request = JsonNode.Parse(await Console.In.ReadLineAsync() ?? "")!.AsObject();
            Args = request["arguments"]?.AsObject() ?? new();
            Connection = request["connection"]!.AsObject(); Password = request["password"]?.GetValue<string>();
            string action = request["action"]!.GetValue<string>();
            bool readOnly = action is "version" or "script" or "dacPreview" or "importPreview" or "export" or "extract" or "bacpacExport" or "azureList" or "azureBackups";
            if (!readOnly && request["confirmed"]?.GetValue<bool>() != true) throw new InvalidOperationException("Operation was not confirmed.");
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
            string text = string.Join(" ", causes);
            if (!string.IsNullOrEmpty(Password)) text = text.Replace(Password, "[redacted]", StringComparison.Ordinal);
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

    private static void SelfTest()
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
            Emit(new { type = "result", value = new { tests = 6, status = "passed" } });
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
        if (B("entra") || authentication["kind"]!.GetValue<string>() == "entra") { cs.IntegratedSecurity = false; cs.Remove("User ID"); cs.Remove("Password"); }
        return cs;
    }

    private static async Task<SqlConnection> Open(bool encrypted = false)
    {
        var connection = new SqlConnection(Builder(encrypted).ConnectionString);
        try
        {
            if (B("entra") || Connection["authentication"]?["kind"]?.GetValue<string>() == "entra") connection.AccessToken = (await Token("https://database.windows.net/.default")).Token;
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
        var service = Connection["authentication"]?["kind"]?.GetValue<string>() == "entra" ? new DacServices(Builder().ConnectionString, new SqlTokenProvider()) : new DacServices(Builder().ConnectionString);
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
        using var package = DacPackage.Load(path);
        var options = new DacDeployOptions { BlockOnPossibleDataLoss = true, DropObjectsNotInSource = B("dropMissing"), CreateNewDatabase = false };
        string hash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(path)));
        if (action == "dacPreview") return new { script = service.GenerateDeployScript(package, database, options), report = service.GenerateDeployReport(package, database, options), packageHash = hash };
        if (S("packageHash") != hash) throw new Exception("The package changed. Generate and approve a new preview.");
        service.Deploy(package, database, true, options); return new { database };
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
            if (delimiter.Length != 1) throw new Exception("The CSV delimiter must be a single character.");
            var text = new StreamReader(path, Encoding.UTF8, true);
            var records = CsvRecords(text, delimiter[0]).GetEnumerator();
            if (!records.MoveNext()) { records.Dispose(); text.Dispose(); throw new Exception("Missing CSV header."); }
            columns = records.Current;
            return ReadCsv(text, records);
        }
        var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var reader = ExcelDataReader.ExcelReaderFactory.CreateReader(stream);
        int sheet = I("sheet"); while (sheet-- > 0) if (!reader.NextResult()) { reader.Dispose(); throw new Exception("Worksheet not found."); }
        if (!reader.Read()) { reader.Dispose(); throw new Exception("Missing worksheet header."); }
        columns = Enumerable.Range(0, reader.FieldCount).Select(i => Convert.ToString(reader.GetValue(i), Invariant) ?? "").ToArray();
        return Path.GetExtension(path).Equals(".xlsx", StringComparison.OrdinalIgnoreCase) ? ReadExactExcel(path, reader) : ReadExcel(reader);
    }
    private static IEnumerable<object?[]> ReadCsv(StreamReader reader, IEnumerator<string[]> records)
    {
        using (reader) using (records) while (records.MoveNext())
            yield return records.Current.Select(v => (object?)(v == S("nullToken", @"\N") ? null : B("backslashEscaping") && v.StartsWith(@"\\", StringComparison.Ordinal) ? v[1..] : v)).ToArray();
    }
    /// <summary>RFC 4180 records: quoted fields keep delimiters, quotes and line breaks, blank lines included.</summary>
    private static IEnumerable<string[]> CsvRecords(TextReader reader, char delimiter)
    {
        var fields = new List<string>(); var field = new StringBuilder(); bool quoted = false, any = false;
        int c;
        while ((c = reader.Read()) != -1)
        {
            char ch = (char)c;
            if (quoted)
            {
                if (ch == '"') { if (reader.Peek() == '"') { reader.Read(); field.Append('"'); } else quoted = false; }
                else field.Append(ch);
                continue;
            }
            if (ch == '"' && field.Length == 0) { quoted = true; any = true; }
            else if (ch == delimiter) { fields.Add(field.ToString()); field.Clear(); any = true; }
            else if (ch == '\r' || ch == '\n')
            {
                if (ch == '\r' && reader.Peek() == '\n') reader.Read();
                // A line with nothing on it is not a record.
                if (any) { fields.Add(field.ToString()); yield return fields.ToArray(); }
                fields.Clear(); field.Clear(); any = false;
            }
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
                if (cell.CellReference?.Value is string reference) { column = 0; foreach (char c in reference) { if (c < 'A' || c > 'Z') break; column = column * 26 + (c - 'A' + 1); } column--; }
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
        string target = Q(S("schema", "dbo")) + "." + Q(S("table"));
        try
        {
            var metadata = new Dictionary<string, (string Name, string Type, int Length)>(StringComparer.OrdinalIgnoreCase);
            // CLR types (hierarchyid, geometry, geography) share system type 240; alias types resolve to their base type.
            await using (var command = new SqlCommand("SELECT c.name,CASE WHEN c.system_type_id=240 THEN TYPE_NAME(c.user_type_id) ELSE TYPE_NAME(c.system_type_id) END,c.max_length FROM sys.columns c WHERE c.object_id=OBJECT_ID(@target) AND c.is_computed=0 AND c.generated_always_type=0", connection, transaction))
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
        catch { await transaction.RollbackAsync(); throw; }
    }

    // decimal(38) does not fit System.Decimal, and OdbcDataReader.IsDBNull reads the value
    // as one: read decimals as text, where NULL shows as InvalidCastException.
    private static object? OdbcValue(System.Data.Common.DbDataReader reader, int i)
    {
        if (reader.GetFieldType(i) != typeof(decimal)) return reader.IsDBNull(i) ? null : reader.GetValue(i);
        try { return reader.GetString(i); } catch (InvalidCastException) { return null; }
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
                case "decimal" or "numeric": return new SqlDecimal((decimal)number);
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
            if (type == "datetimeoffset") return new DateTimeOffset(moment, TimeSpan.Zero);
            if (type is not ("date" or "datetime" or "datetime2" or "smalldatetime")) value = moment.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", Invariant);
        }
        string text = Convert.ToString(value, Invariant) ?? "";
        return type switch
        {
            "decimal" or "numeric" => SqlDecimal.Parse(text),
            "money" or "smallmoney" => decimal.Parse(text, NumberStyles.Number, Invariant),
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
            "binary" or "varbinary" or "image" => value is byte[] bytes ? bytes : Convert.FromHexString(text.StartsWith("0x") ? text[2..] : text),
            _ => text
        };
    }

    private static void ValidateSourceQuery(string sql)
    {
        string tokens = System.Text.RegularExpressions.Regex.Replace(sql, """'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:\]\]|[^\]])*\]|`(?:``|[^`])*`|--[^\r\n]*|/\*[\s\S]*?\*/""", " ");
        if (!System.Text.RegularExpressions.Regex.IsMatch(tokens, @"^\s*(SELECT|WITH)\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase) || System.Text.RegularExpressions.Regex.IsMatch(tokens, @"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|CALL|GRANT|DENY|REVOKE|INTO|OUTFILE|DUMPFILE)\b|;\s*\S", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) throw new Exception("The ODBC source must be one SELECT query; preview and import do not execute source writes.");
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
        "binary" or "varbinary" or "image" => typeof(byte[]),
        _ => typeof(string)
    };

    private static string? Exact(SqlDataReader reader, int i)
    {
        if (reader.IsDBNull(i)) return null;
        if (reader.GetDataTypeName(i) is "decimal" or "numeric") return reader.GetSqlDecimal(i).ToString();
        object value = reader.GetValue(i);
        return value switch { byte[] b => "0x" + Convert.ToHexString(b), DateTime date => date.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", Invariant), DateTimeOffset date => date.ToString("O", Invariant), TimeSpan time => time.ToString("c", Invariant), bool bit => bit ? "1" : "0", IFormattable f => f.ToString(null, Invariant), _ => value.ToString() };
    }
    private static string Csv(string? text) { string value = text is null ? @"\N" : text.StartsWith((char)92) ? ((char)92) + text : text; return "\"" + value.Replace("\"", "\"\"") + "\""; }

    private static async Task<object> Export()
    {
        await using var connection = await Open();
        string path = S("path"), temp = path + ".quervio-partial-" + Guid.NewGuid().ToString("N"); long rows = 0;
        try
        {
            await using var command = new SqlCommand("SELECT * FROM " + Q(S("schema", "dbo")) + "." + Q(S("table")), connection) { CommandTimeout = 0 };
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess);
            if (Path.GetExtension(path).Equals(".xlsx", StringComparison.OrdinalIgnoreCase))
            {
                IEnumerable<string?[]> Rows() { while (reader.Read()) yield return Enumerable.Range(0, reader.FieldCount).Select(i => Exact(reader, i)).ToArray(); }
                rows = WriteWorkbook(temp, Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray(), Rows());
            }
            else
            {
                await using var writer = new StreamWriter(temp, false, new UTF8Encoding(true));
                await writer.WriteLineAsync(string.Join(",", Enumerable.Range(0, reader.FieldCount).Select(i => "\"" + reader.GetName(i).Replace("\"", "\"\"") + "\"")));
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
            if (c == '_' && i + 6 < text.Length && text[i + 1] == 'x' && text[i + 6] == '_' && text.Substring(i + 2, 4).All(Uri.IsHexDigit)) result.Append("_x005F_");
            else if (c < 0x20 && c != '\t' && c != '\n' || c == '\uFFFE' || c == '\uFFFF') result.Append("_x").Append(((int)c).ToString("X4", Invariant)).Append('_');
            else result.Append(c);
        }
        return result.ToString();
    }

    private static async Task<object> EncryptedQuery()
    {
        await using var connection = await Open(true);
        await using var command = new SqlCommand(S("query"), connection) { CommandTimeout = I("timeout", 30) };
        foreach (var node in Args["parameters"]?.AsArray() ?? JsonNode.Parse(S("parametersJson", "[]"))!.AsArray())
        {
            var item = node!.AsObject(); var type = Enum.Parse<SqlDbType>(item["type"]!.GetValue<string>(), true);
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
        var start = new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe")) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, UseShellExecute = false, CreateNoWindow = true };
        foreach (string argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", Path.Combine(AppContext.BaseDirectory, "ColumnEncryption.ps1") }) start.ArgumentList.Add(argument);
        using var process = System.Diagnostics.Process.Start(start) ?? throw new Exception("Could not start the Microsoft column encryption tool.");
        string? token = Connection["authentication"]?["kind"]?.GetValue<string>() == "entra" ? (await Token("https://database.windows.net/.default")).Token : null;
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { connectionString = Builder(true).ConnectionString, accessToken = token, schema = S("schema", "dbo"), table = S("table"), column = S("column"), key = S("key"), decrypt = B("decrypt"), encryptionType = S("encryptionType", "Deterministic") }));
        process.StandardInput.Close();
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(); string output = await stdout; string error = await stderr;
        if (process.ExitCode != 0) throw new Exception(string.IsNullOrWhiteSpace(error) ? output : error);
        return new { message = output.Trim() };
    }

    private static async Task<object> CreateColumnKeys()
    {
        string master = S("masterKey"), key = S("key"), path = S("backupPath"), password = S("backupPassword");
        if (string.IsNullOrWhiteSpace(master) || string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(path) || password.Length < 12) throw new Exception("Provide key names, a new PFX backup path and a password of at least 12 characters.");
        if (File.Exists(path)) throw new Exception("The PFX backup destination already exists.");
        using var rsa = RSA.Create(3072);
        var request = new CertificateRequest("CN=Quervio Always Encrypted", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyEncipherment | X509KeyUsageFlags.DataEncipherment, true));
        using var generated = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(5));
        byte[] pfx = generated.Export(X509ContentType.Pfx, password);
        // The backup is created before registering keys in the database.
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) await file.WriteAsync(pfx);
        using var certificate = X509CertificateLoader.LoadPkcs12(pfx, password, X509KeyStorageFlags.PersistKeySet | X509KeyStorageFlags.Exportable | X509KeyStorageFlags.UserKeySet);
        CryptographicOperations.ZeroMemory(pfx);
        using (var store = new X509Store(StoreName.My, StoreLocation.CurrentUser)) { store.Open(OpenFlags.ReadWrite); store.Add(certificate); }
        string keyPath = "CurrentUser/My/" + certificate.Thumbprint;
        byte[] plain = RandomNumberGenerator.GetBytes(32); byte[] encrypted;
        try { encrypted = new SqlColumnEncryptionCertificateStoreProvider().EncryptColumnEncryptionKey(keyPath, "RSA_OAEP", plain); } finally { CryptographicOperations.ZeroMemory(plain); }
        await using var connection = await Open();
        await using var command = new SqlCommand($"CREATE COLUMN MASTER KEY {Q(master)} WITH(KEY_STORE_PROVIDER_NAME=N'MSSQL_CERTIFICATE_STORE',KEY_PATH={L(keyPath)}); CREATE COLUMN ENCRYPTION KEY {Q(key)} WITH VALUES(COLUMN_MASTER_KEY={Q(master)},ALGORITHM=N'RSA_OAEP',ENCRYPTED_VALUE=0x{Convert.ToHexString(encrypted)});", connection);
        await command.ExecuteNonQueryAsync(); return new { masterKey = master, key, keyPath, backupPath = path };
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

    private static async Task<object> Azure(string action)
    {
        string id = S("resourceId"); if (!id.StartsWith("/subscriptions/", StringComparison.OrdinalIgnoreCase) || id.Contains('?') || id.Contains("..")) throw new Exception("Use a full Azure SQL resource ID.");
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
        string target = S("targetResourceId"); if (!target.StartsWith("/subscriptions/", StringComparison.OrdinalIgnoreCase) || target == id || target.Contains('?') || target.Contains("..")) throw new Exception("Restore requires a different full destination resource ID.");
        var source = await Send(HttpMethod.Get, id);
        return await Send(HttpMethod.Put, target, new JsonObject { ["location"] = source["location"]!.DeepClone(), ["properties"] = new JsonObject { ["createMode"] = "PointInTimeRestore", ["sourceDatabaseId"] = id, ["restorePointInTime"] = DateTimeOffset.Parse(S("pointInTime"), Invariant).ToString("O") } });
    }
}
