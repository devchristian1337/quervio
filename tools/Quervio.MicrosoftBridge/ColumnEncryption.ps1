$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    if (-not (Get-Module -ListAvailable SqlServer | Where-Object Version -ge '22.0')) {
        throw 'Column migration requires the official Microsoft SqlServer PowerShell module, version 22 or later.'
    }
    Import-Module SqlServer -MinimumVersion 22.0 -ErrorAction Stop
    $payload = [Console]::In.ReadLine() | ConvertFrom-Json
    $databaseArgs = @{ ConnectionString = $payload.connectionString }
    if ($payload.accessToken) { $databaseArgs.AccessToken = $payload.accessToken }
    $database = Get-SqlDatabase @databaseArgs
    $settingsArgs = @{
        ColumnName = ('[{0}].[{1}].[{2}]' -f $payload.schema.Replace(']', ']]'), $payload.table.Replace(']', ']]'), $payload.column.Replace(']', ']]'))
        EncryptionType = $(if ($payload.decrypt) { 'Plaintext' } else { $payload.encryptionType })
    }
    if (-not $payload.decrypt) { $settingsArgs.EncryptionKey = $payload.key }
    $settings = New-SqlColumnEncryptionSettings @settingsArgs
    Set-SqlColumnEncryption -InputObject $database -ColumnEncryptionSettings $settings -ErrorAction Stop
    [Console]::Out.WriteLine('Column encryption migration completed.')
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
