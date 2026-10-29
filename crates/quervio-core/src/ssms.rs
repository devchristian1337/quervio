//! The connections SQL Server Management Studio knows, to import as Saved
//! Connections. Two sources, which every version from 18 on writes one of:
//!
//! - Registered Servers, with their groups: `RegSrvr*.xml` in
//!   `%APPDATA%\Microsoft\SQL Server Management Studio` (SSMS 22 writes
//!   `RegSrvr17.xml`) or, before, in `Microsoft SQL Server\<n>\Tools\Shell`.
//!   A `.regsrvr` file exported from any version has the same shape. Their
//!   connection strings carry the password DPAPI-encrypted for the user.
//! - The Connect dialog's history of SSMS 18 to 21: `UserSettings.xml` in
//!   each version's folder, without passwords.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use roxmltree::Node;
use serde::Serialize;

use crate::connection::{Authentication, Encrypt, Environment, SavedConnection};
use crate::secrets;

/// The server type of the Database Engine in SSMS's history.
const DATABASE_ENGINE: &str = "8c91a03d-f9b4-46c0-a305-b5dcc79ff907";
/// .NET ticks (100 ns since year 1) at the Unix epoch.
const UNIX_EPOCH_TICKS: u64 = 621_355_968_000_000_000;
/// Where the Database Engine's registered servers and groups sit in a store.
const ENGINE_GROUP: &str = "/RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup/";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Registered,
    History,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsmsConnection {
    /// Identifies it within one reading, for picking what to import.
    pub id: String,
    /// The registered server's name; empty for a history entry.
    pub name: String,
    /// The registered server's groups, outermost first.
    pub groups: Vec<String>,
    pub server: String,
    pub authentication: Authentication,
    pub default_database: Option<String>,
    pub encrypt: Encrypt,
    pub trust_server_certificate: bool,
    /// When SSMS last connected with it, in milliseconds since the Unix epoch.
    pub last_used: Option<i64>,
    pub source: Source,
    /// The SSMS version whose history it comes from, such as "21.0".
    pub ssms_version: Option<String>,
    pub has_password: bool,
    /// As SSMS stored it; decrypted only when imported.
    #[serde(skip)]
    encrypted_password: Option<Vec<u8>>,
}

impl SsmsConnection {
    /// The Saved Connection to create, named after its groups and name.
    pub fn to_saved(&self, environment: Environment) -> SavedConnection {
        let name = if self.name.is_empty() || (self.name.eq_ignore_ascii_case(&self.server) && self.groups.is_empty()) {
            String::new()
        } else {
            [self.groups.as_slice(), std::slice::from_ref(&self.name)].concat().join(" / ")
        };
        SavedConnection {
            id: String::new(),
            name,
            server: self.server.clone(),
            authentication: self.authentication.clone(),
            default_database: self.default_database.clone(),
            environment,
            encrypt: self.encrypt,
            trust_server_certificate: self.trust_server_certificate,
        }
    }

    /// The saved password, decrypted for the current Windows user; None when
    /// there is none or it cannot be read (another user's, another machine's).
    pub fn password(&self) -> Option<String> {
        let plain = secrets::unprotect_for_current_user(self.encrypted_password.as_deref()?).ok()?;
        Some(password_text(&plain)).filter(|password| !password.is_empty())
    }
}

/// .NET encrypts the password's UTF-16 bytes; UTF-8 is the fallback.
fn password_text(plain: &[u8]) -> String {
    if plain.len() % 2 == 0 {
        let units: Vec<u16> = plain.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        if let Ok(text) = String::from_utf16(&units) {
            if !text.chars().any(char::is_control) {
                return text;
            }
        }
    }
    String::from_utf8_lossy(plain).into_owned()
}

/// `%APPDATA%` of the current Windows user, under which SSMS keeps both sources.
pub fn app_data() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// Every connection SSMS keeps under `app_data`: the registered servers by
/// group, then the history not already among them, most recent first. A
/// missing folder or an unreadable file adds nothing.
pub fn discover(app_data: &Path) -> Vec<SsmsConnection> {
    let studio = app_data.join("Microsoft").join("SQL Server Management Studio");
    let mut stores = registered_stores(&studio);
    for version in subfolders(&app_data.join("Microsoft").join("Microsoft SQL Server")) {
        stores.extend(registered_stores(&version.join("Tools").join("Shell")));
    }
    let registered = stores.iter().filter_map(|path| fs::read(path).ok()).flat_map(|bytes| read_registered_servers(&decode(&bytes)));
    let mut history = Vec::new();
    for version in subfolders(&studio) {
        if let Ok(bytes) = fs::read(version.join("UserSettings.xml")) {
            let name = version.file_name().unwrap_or_default().to_string_lossy().into_owned();
            history.extend(read_user_settings(&decode(&bytes), &name));
        }
    }
    merge(registered.collect(), history)
}

/// The registered servers of an exported `.regsrvr` file.
pub fn read_file(path: &Path) -> std::io::Result<Vec<SsmsConnection>> {
    let bytes = fs::read(path)?;
    Ok(merge(read_registered_servers(&decode(&bytes)), Vec::new()))
}

/// `RegSrvr.xml`, `RegSrvr17.xml`… in a folder.
fn registered_stores(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut stores: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            name.starts_with("regsrvr") && name.ends_with(".xml")
        })
        .collect();
    // The newest store's servers win where two have the same one.
    stores.sort_by_key(|path| std::cmp::Reverse(fs::metadata(path).and_then(|m| m.modified()).ok()));
    stores
}

fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect()
}

/// UTF-8 or, by its byte order mark, UTF-16, as .NET may write it.
fn decode(bytes: &[u8]) -> String {
    let encoding = encoding_rs::Encoding::for_bom(bytes).map_or(encoding_rs::UTF_8, |(encoding, _)| encoding);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

// ─── Registered Servers ─────────────────────────────────────────────────────

/// The Database Engine's registered servers in a store or export; none if it does not parse.
pub fn read_registered_servers(xml: &str) -> Vec<SsmsConnection> {
    let Ok(document) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    document
        .descendants()
        .filter(|node| node.has_tag_name("document"))
        .filter_map(registered_server)
        .collect()
}

/// One store document: an alias such as `…/ServerGroup/Aurelia/RegisteredServer/Nightly`
/// and the server's properties.
fn registered_server(document: Node) -> Option<SsmsConnection> {
    let alias = document.descendants().find(|node| node.has_tag_name("alias"))?.text()?;
    let path = alias.strip_prefix(ENGINE_GROUP)?;
    let data = local_child(document, "data")?.children().find(Node::is_element)?;
    let property = |name: &str| local_child(data, name).and_then(|node| node.text()).unwrap_or_default().trim();
    if property("ServerType") != "DatabaseEngine" || !path.contains("RegisteredServer/") {
        return None;
    }
    let groups = groups_of(path);
    let name = property("Name").to_string();
    let options = connection_string(property("ConnectionStringWithEncryptedPassword"));
    let option = |key: &str| options.iter().find(|(k, _)| k == key).map(|(_, value)| value.as_str()).unwrap_or_default();
    let server = Some(property("ServerName")).filter(|server| !server.is_empty()).unwrap_or(option("data source")).to_string();
    if server.is_empty() {
        return None;
    }
    let windows = is_true(option("integrated security"));
    let authentication = match property("AuthenticationType") {
        _ if windows => Authentication::Windows,
        "0" => Authentication::Windows,
        "1" => Authentication::Sql { user_name: option("user id").to_string() },
        // Entra ID logins come in several kinds; they are not mapped yet.
        _ => return None,
    };
    let encrypted_password = Some(option("password"))
        .filter(|password| !password.is_empty())
        .and_then(|password| base64::engine::general_purpose::STANDARD.decode(password).ok());
    Some(SsmsConnection {
        id: format!("registered:{path}"),
        name,
        groups,
        server,
        authentication,
        default_database: Some(option("initial catalog")).filter(|db| !db.is_empty()).map(str::to_string),
        encrypt: match option("encrypt").to_lowercase().as_str() {
            "true" | "yes" | "mandatory" => Encrypt::Mandatory,
            "strict" => Encrypt::Strict,
            _ => Encrypt::Optional,
        },
        trust_server_certificate: is_true(option("trust server certificate")),
        last_used: None,
        source: Source::Registered,
        ssms_version: None,
        has_password: encrypted_password.is_some(),
        encrypted_password,
    })
}

/// The group names on a path such as `ServerGroup/A/ServerGroup/B/RegisteredServer/X`.
fn groups_of(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    parts
        .windows(2)
        .filter(|pair| pair[0] == "ServerGroup")
        .map(|pair| pair[1].to_string())
        .collect()
}

/// `key=value;…` pairs with lowercase keys; a value may be quoted.
fn connection_string(text: &str) -> Vec<(String, String)> {
    text.split(';')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| {
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            (key.trim().to_lowercase(), value.to_string())
        })
        .collect()
}

fn is_true(value: &str) -> bool {
    matches!(value.to_lowercase().as_str(), "true" | "yes" | "sspi")
}

fn local_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.tag_name().name() == name)
}

// ─── Connect dialog history ─────────────────────────────────────────────────

/// The Database Engine connections in one `UserSettings.xml`; none if it does not parse.
pub fn read_user_settings(xml: &str, version: &str) -> Vec<SsmsConnection> {
    let Ok(document) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    document
        .descendants()
        .filter(|node| node.has_tag_name("ServerConnectionSettings"))
        .filter_map(|settings| history_entry(settings, version))
        .collect()
}

fn history_entry(settings: Node, version: &str) -> Option<SsmsConnection> {
    if !text(settings, "ServerType").eq_ignore_ascii_case(DATABASE_ENGINE) {
        return None;
    }
    let server = text(settings, "Instance").trim().to_string();
    if server.is_empty() {
        return None;
    }
    let authentication = match text(settings, "AuthenticationMethod").trim() {
        "0" => Authentication::Windows,
        "1" => Authentication::Sql { user_name: text(settings, "UserName").trim().to_string() },
        _ => return None,
    };
    let advanced = advanced(settings);
    let option = |key: &str| advanced.iter().find(|(k, _)| k == key).map(|(_, value)| value.as_str()).unwrap_or_default();
    let database = [text(settings, "Database"), option("IniDb")]
        .into_iter()
        .map(str::trim)
        // SSMS shows "<default>" for the login's own database.
        .find(|name| !name.is_empty() && !name.starts_with('<'))
        .map(str::to_string);
    let mut entry = SsmsConnection {
        id: String::new(),
        name: String::new(),
        groups: Vec::new(),
        server,
        authentication,
        default_database: database,
        encrypt: if option("EC").eq_ignore_ascii_case("true") { Encrypt::Mandatory } else { Encrypt::Optional },
        trust_server_certificate: option("TSC").eq_ignore_ascii_case("true"),
        last_used: last_used(settings),
        source: Source::History,
        ssms_version: Some(version.to_string()),
        has_password: false,
        encrypted_password: None,
    };
    let (server, login) = identity(&entry);
    entry.id = format!("history:{server}|{login}");
    Some(entry)
}

/// The text of a child element, empty when it is missing.
fn text<'a>(node: Node<'a, '_>, name: &str) -> &'a str {
    child(node, name).and_then(|child| child.text()).unwrap_or_default()
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(name))
}

/// The `Advanced` options: short keys such as EC (encrypt) and TSC (trust the certificate).
fn advanced(settings: Node) -> Vec<(String, String)> {
    let Some(options) = child(settings, "Advanced") else {
        return Vec::new();
    };
    options
        .children()
        .filter(|element| element.has_tag_name("Element"))
        .filter_map(|element| {
            let key = child(element, "Key").map(|key| text(key, "string"))?;
            let value = child(element, "Value").map(|value| text(value, "string")).unwrap_or_default();
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

/// The `Time` beside the settings: .NET ticks, stored negated so the newest sorts first.
fn last_used(settings: Node) -> Option<i64> {
    let element = settings.parent()?.parent()?;
    let time: i64 = child(element, "Time").map(|time| text(time, "long"))?.trim().parse().ok()?;
    let ticks = time.unsigned_abs().checked_sub(UNIX_EPOCH_TICKS)?;
    i64::try_from(ticks / 10_000).ok()
}

// ─── Merging ────────────────────────────────────────────────────────────────

/// Registered servers by group and name, each once; then the history most
/// recent first, without the logins a registered server already has.
fn merge(mut registered: Vec<SsmsConnection>, mut history: Vec<SsmsConnection>) -> Vec<SsmsConnection> {
    let mut ids = HashSet::new();
    registered.retain(|connection| ids.insert(connection.id.clone()));
    registered.sort_by(|a, b| (&a.groups, a.name.to_lowercase()).cmp(&(&b.groups, b.name.to_lowercase())));
    let mut logins: HashSet<_> = registered.iter().map(identity).collect();
    history.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    history.retain(|connection| logins.insert(identity(connection)));
    registered.extend(history);
    registered
}

fn identity(connection: &SsmsConnection) -> (String, String) {
    let login = match &connection.authentication {
        Authentication::Sql { user_name } => format!("sql:{}", user_name.to_lowercase()),
        Authentication::Windows => "windows".into(),
        Authentication::Entra => "entra".into(),
    };
    (connection.server.to_lowercase(), login)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One history entry as SSMS 20 and 21 write it.
    fn history(instance: &str, method: u8, user: &str, time: i64, options: &[(&str, &str)]) -> String {
        let advanced: String = options
            .iter()
            .map(|(key, value)| {
                format!("<Element><Key><string>{key}</string></Key><Value><string>{value}</string></Value></Element>")
            })
            .collect();
        format!(
            "<Element><Time><long>{time}</long></Time><Item><ServerConnectionItem>\
             <Instance>{instance}</Instance><AuthenticationMethod>{method}</AuthenticationMethod><Connections>\
             <Element><Time><long>{time}</long></Time><Item><ServerConnectionSettings>\
             <Password /><Instance>{instance}</Instance><UserName>{user}</UserName>\
             <ServerType>{DATABASE_ENGINE}</ServerType><AuthenticationMethod>{method}</AuthenticationMethod>\
             <Database /><Advanced>{advanced}</Advanced>\
             </ServerConnectionSettings></Item></Element>\
             </Connections></ServerConnectionItem></Item></Element>"
        )
    }

    fn user_settings(entries: &[String]) -> String {
        format!(
            "\u{feff}<?xml version=\"1.0\" encoding=\"utf-8\"?><SqlStudio><SSMS><ConnectionOptions>\
             <ServerTypes><Element><Key><guid>{DATABASE_ENGINE}</guid></Key><Value><ServerTypeItem><Servers>{}\
             </Servers></ServerTypeItem></Value></Element></ServerTypes></ConnectionOptions></SSMS></SqlStudio>",
            entries.concat()
        )
    }

    /// One registered server document, as in RegSrvr17.xml and .regsrvr exports.
    fn registered(path: &str, name: &str, server: &str, authentication: u8, connection: &str) -> String {
        format!(
            "<document><docinfo><aliases><alias>/RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup/{path}</alias></aliases>\
             <sfc:version DomainVersion=\"1\" /></docinfo><data><RegisteredServers:RegisteredServer>\
             <RegisteredServers:Parent><sfc:Reference sml:ref=\"true\"><sml:Uri>/x</sml:Uri></sfc:Reference></RegisteredServers:Parent>\
             <RegisteredServers:Name type=\"string\">{name}</RegisteredServers:Name>\
             <RegisteredServers:ServerName type=\"string\">{server}</RegisteredServers:ServerName>\
             <RegisteredServers:ServerType type=\"ServerType\">DatabaseEngine</RegisteredServers:ServerType>\
             <RegisteredServers:ConnectionStringWithEncryptedPassword type=\"string\">{connection}</RegisteredServers:ConnectionStringWithEncryptedPassword>\
             <RegisteredServers:CredentialPersistenceType type=\"CredentialPersistenceType\">PersistLoginNameAndPassword</RegisteredServers:CredentialPersistenceType>\
             <RegisteredServers:AuthenticationType type=\"int\">{authentication}</RegisteredServers:AuthenticationType>\
             </RegisteredServers:RegisteredServer></data></document>"
        )
    }

    fn store(documents: &[String]) -> String {
        format!(
            "<?xml version=\"1.0\"?><model xmlns=\"http://schemas.serviceml.org/smlif/2007/02\"><xs:bufferSchema \
             xmlns:xs=\"http://www.w3.org/2001/XMLSchema\"><definitions><document><docinfo><aliases><alias>/system/schema/RegisteredServers</alias></aliases></docinfo></document></definitions></xs:bufferSchema>\
             <instances xmlns:RegisteredServers=\"http://schemas.microsoft.com/sqlserver/RegisteredServers/2007/08\" \
             xmlns:sfc=\"http://schemas.microsoft.com/sqlserver/sfc/serialization/2007/08\" \
             xmlns:sml=\"http://schemas.serviceml.org/sml/2007/02\">\
             <document><docinfo><aliases><alias>/RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup/ServerGroup/Aurelia</alias></aliases></docinfo>\
             <data><RegisteredServers:ServerGroup><RegisteredServers:Name type=\"string\">Aurelia</RegisteredServers:Name>\
             <RegisteredServers:ServerType type=\"ServerType\">DatabaseEngine</RegisteredServers:ServerType></RegisteredServers:ServerGroup></data></document>\
             {}</instances></model>",
            documents.concat()
        )
    }

    const SQL_LOGIN: &str = "data source=10.0.0.5;initial catalog=H2O_BASE;user id=sa;password=AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA;pooling=False;encrypt=False;trust server certificate=True;packet size=4096";

    // 2025-10-21 and 2026-06-18, as SSMS 20 and 21 stored them on a real machine.
    const OCTOBER: i64 = -638_966_376_339_370_589;
    const JUNE: i64 = -639_173_758_680_666_846;

    #[test]
    fn reads_a_registered_server_with_its_group_and_options() {
        let xml = store(&[registered("ServerGroup/Aurelia/RegisteredServer/Aurelia [Ambulatorio]", "Aurelia [Ambulatorio]", "10.0.0.5", 1, SQL_LOGIN)]);
        let found = read_registered_servers(&xml);
        assert_eq!(found.len(), 1);
        let server = &found[0];
        assert_eq!(server.groups, ["Aurelia"]);
        assert_eq!(server.authentication, Authentication::Sql { user_name: "sa".into() });
        assert_eq!(server.default_database.as_deref(), Some("H2O_BASE"));
        assert_eq!((server.encrypt, server.trust_server_certificate, server.has_password), (Encrypt::Optional, true, true));
        let saved = server.to_saved(Environment::Production);
        assert_eq!((saved.name.as_str(), saved.server.as_str()), ("Aurelia / Aurelia [Ambulatorio]", "10.0.0.5"));
    }

    #[test]
    fn reads_top_level_and_nested_registered_servers() {
        let xml = store(&[
            registered("RegisteredServer/Nightly", "Nightly", "10.0.0.9", 0, "data source=10.0.0.9;integrated security=True"),
            registered("ServerGroup/Roma/ServerGroup/Test/RegisteredServer/db1", "db1", "", 1, "data source=db1,1433;user id=app;encrypt=Strict"),
        ]);
        let found = read_registered_servers(&xml);
        let summary: Vec<_> = found.iter().map(|c| (c.groups.join("/"), c.server.as_str(), c.encrypt, c.has_password)).collect();
        assert_eq!(
            summary,
            [("".into(), "10.0.0.9", Encrypt::Optional, false), ("Roma/Test".into(), "db1,1433", Encrypt::Strict, false)]
        );
        assert_eq!(found[0].authentication, Authentication::Windows);
        assert_eq!(found[0].to_saved(Environment::Test).name, "Nightly");
    }

    #[test]
    fn skips_other_server_types_and_entra_logins() {
        let analysis = registered("RegisteredServer/olap", "olap", "olap01", 0, "").replace(">DatabaseEngine<", ">AnalysisServices<");
        let entra = registered("RegisteredServer/cloud", "cloud", "x.database.windows.net", 5, "user id=someone@example.com");
        assert!(read_registered_servers(&store(&[analysis, entra])).is_empty());
        assert!(read_registered_servers("not xml").is_empty());
    }

    #[test]
    fn reads_a_history_login_with_its_options() {
        let xml = user_settings(&[history("10.0.0.5", 1, "sa", OCTOBER, &[("EC", "False"), ("TSC", "True"), ("IniDb", "H2O_BASE")])]);
        let found = read_user_settings(xml.trim_start_matches('\u{feff}'), "20.0");
        assert_eq!(found.len(), 1);
        let entry = &found[0];
        assert_eq!(entry.authentication, Authentication::Sql { user_name: "sa".into() });
        assert_eq!(entry.default_database.as_deref(), Some("H2O_BASE"));
        assert_eq!((entry.encrypt, entry.trust_server_certificate), (Encrypt::Optional, true));
        assert_eq!(entry.last_used, Some(1_761_040_833_937));
        assert_eq!(entry.to_saved(Environment::Production).name, "");
    }

    #[test]
    fn maps_windows_history_logins_and_skips_other_kinds() {
        let xml = user_settings(&[
            history(r"srv01\SQL2022", 0, "", OCTOBER, &[("EC", "True")]),
            history("azure.example.net", 5, "someone@example.com", OCTOBER, &[]),
        ]);
        let found = read_user_settings(&xml, "21.0");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].authentication.clone(), found[0].encrypt), (Authentication::Windows, Encrypt::Mandatory));
    }

    #[test]
    fn discovers_every_source_registered_first() {
        let app_data = tempfile::tempdir().unwrap();
        let studio = app_data.path().join("Microsoft").join("SQL Server Management Studio");
        for (version, entries) in [
            ("20.0", vec![history("10.0.0.5", 1, "SA", OCTOBER, &[]), history("10.0.0.7", 1, "app", OCTOBER, &[])]),
            ("21.0", vec![history("10.0.0.7", 1, "app", JUNE, &[("TSC", "True")])]),
            ("22.0", vec![]),
        ] {
            fs::create_dir_all(studio.join(version)).unwrap();
            fs::write(studio.join(version).join("UserSettings.xml"), user_settings(&entries)).unwrap();
        }
        fs::write(
            studio.join("RegSrvr17.xml"),
            store(&[registered("ServerGroup/Aurelia/RegisteredServer/Aurelia", "Aurelia", "10.0.0.5", 1, SQL_LOGIN)]),
        )
        .unwrap();
        let found = discover(app_data.path());
        let summary: Vec<_> = found.iter().map(|c| (c.server.as_str(), c.source, c.ssms_version.as_deref(), c.trust_server_certificate)).collect();
        // 10.0.0.5 as sa is registered, so its history entry is left out.
        assert_eq!(summary, [("10.0.0.5", Source::Registered, None, true), ("10.0.0.7", Source::History, Some("21.0"), true)]);
    }

    #[test]
    fn finds_nothing_without_ssms() {
        assert!(discover(Path::new("does-not-exist")).is_empty());
    }

    #[test]
    fn reads_passwords_as_dotnet_writes_them() {
        let utf16: Vec<u8> = "Pàss;1".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(password_text(&utf16), "Pàss;1");
        assert_eq!(password_text("plain".as_bytes()), "plain");
    }
}
