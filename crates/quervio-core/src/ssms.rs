//! The connections SQL Server Management Studio remembers, to import as
//! Saved Connections. SSMS 18 to 21 keep the Connect dialog's history in
//! `%APPDATA%\Microsoft\SQL Server Management Studio\<version>\UserSettings.xml`:
//! per server its address and, per login, the authentication, database and
//! advanced options. Passwords are not in that file, so none are imported.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use roxmltree::Node;
use serde::Serialize;

use crate::connection::{Authentication, Encrypt};

/// The server type of the Database Engine in SSMS's history.
const DATABASE_ENGINE: &str = "8c91a03d-f9b4-46c0-a305-b5dcc79ff907";
/// .NET ticks (100 ns since year 1) at the Unix epoch.
const UNIX_EPOCH_TICKS: u64 = 621_355_968_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsmsConnection {
    pub server: String,
    pub authentication: Authentication,
    pub default_database: Option<String>,
    pub encrypt: Encrypt,
    pub trust_server_certificate: bool,
    /// When SSMS last connected with it, in milliseconds since the Unix epoch.
    pub last_used: Option<i64>,
    /// The SSMS version whose history it comes from, such as "21.0".
    pub ssms_version: String,
}

/// Where SSMS keeps a folder per version, for the current Windows user.
pub fn default_dir() -> Option<PathBuf> {
    let app_data = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(app_data).join("Microsoft").join("SQL Server Management Studio"))
}

/// Every version's history under `dir`, most recent first, each server and
/// login once. A missing folder or an unreadable file adds nothing.
pub fn discover(dir: &Path) -> Vec<SsmsConnection> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Ok(bytes) = fs::read(entry.path().join("UserSettings.xml")) else {
            continue;
        };
        let version = entry.file_name().to_string_lossy().into_owned();
        found.extend(read_user_settings(&decode(&bytes), &version));
    }
    merge(found)
}

/// The Database Engine connections in one `UserSettings.xml`; none if it does not parse.
pub fn read_user_settings(xml: &str, version: &str) -> Vec<SsmsConnection> {
    let Ok(document) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    document
        .descendants()
        .filter(|node| node.has_tag_name("ServerConnectionSettings"))
        .filter_map(|settings| connection(settings, version))
        .collect()
}

/// UTF-8 or, by its byte order mark, UTF-16, as .NET may write it.
fn decode(bytes: &[u8]) -> String {
    let encoding = encoding_rs::Encoding::for_bom(bytes).map_or(encoding_rs::UTF_8, |(encoding, _)| encoding);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

fn connection(settings: Node, version: &str) -> Option<SsmsConnection> {
    if !text(settings, "ServerType").eq_ignore_ascii_case(DATABASE_ENGINE) {
        return None;
    }
    let server = text(settings, "Instance").trim().to_string();
    if server.is_empty() {
        return None;
    }
    // Entra ID logins come in several kinds SSMS numbers on; only these two map for sure.
    let authentication = match text(settings, "AuthenticationMethod").trim() {
        "0" => Authentication::Windows,
        "1" => Authentication::Sql {
            user_name: text(settings, "UserName").trim().to_string(),
        },
        _ => return None,
    };
    let advanced = advanced(settings);
    let option = |key: &str| advanced.get(key).map(String::as_str).unwrap_or_default();
    let database = [text(settings, "Database"), option("IniDb")]
        .into_iter()
        .map(str::trim)
        // SSMS shows "<default>" for the login's own database.
        .find(|name| !name.is_empty() && !name.starts_with('<'))
        .map(str::to_string);
    Some(SsmsConnection {
        server,
        authentication,
        default_database: database,
        encrypt: if option("EC").eq_ignore_ascii_case("true") { Encrypt::Mandatory } else { Encrypt::Optional },
        trust_server_certificate: option("TSC").eq_ignore_ascii_case("true"),
        last_used: last_used(settings),
        ssms_version: version.to_string(),
    })
}

/// The text of a child element, empty when it is missing.
fn text<'a>(node: Node<'a, '_>, name: &str) -> &'a str {
    child(node, name).and_then(|child| child.text()).unwrap_or_default()
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(name))
}

/// The `Advanced` options: short keys such as EC (encrypt) and TSC (trust the certificate).
fn advanced(settings: Node) -> HashMap<String, String> {
    let Some(options) = child(settings, "Advanced") else {
        return HashMap::new();
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

/// Most recent first, keeping one entry per server and login.
fn merge(mut found: Vec<SsmsConnection>) -> Vec<SsmsConnection> {
    found.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    let mut seen = HashSet::new();
    found.retain(|connection| seen.insert(identity(connection)));
    found
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

    /// One server entry as SSMS 20 and 21 write it.
    fn server(instance: &str, method: u8, user: &str, time: i64, options: &[(&str, &str)]) -> String {
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

    fn user_settings(servers: &[String]) -> String {
        format!(
            "\u{feff}<?xml version=\"1.0\" encoding=\"utf-8\"?><SqlStudio><SSMS><ConnectionOptions>\
             <ServerTypes><Element><Key><guid>{DATABASE_ENGINE}</guid></Key><Value><ServerTypeItem><Servers>{}\
             </Servers></ServerTypeItem></Value></Element></ServerTypes></ConnectionOptions></SSMS></SqlStudio>",
            servers.concat()
        )
    }

    // 2025-10-21, as SSMS 20 stored it on a real machine.
    const OCTOBER: i64 = -638_966_376_339_370_589;
    const JUNE: i64 = -639_173_758_680_666_846;

    #[test]
    fn reads_a_sql_login_with_its_options() {
        let xml = user_settings(&[server(
            "10.0.0.5",
            1,
            "sa",
            OCTOBER,
            &[("EC", "False"), ("TSC", "True"), ("IniDb", "H2O_BASE"), ("CT", "30")],
        )]);
        let found = read_user_settings(xml.trim_start_matches('\u{feff}'), "20.0");
        assert_eq!(
            found,
            [SsmsConnection {
                server: "10.0.0.5".into(),
                authentication: Authentication::Sql { user_name: "sa".into() },
                default_database: Some("H2O_BASE".into()),
                encrypt: Encrypt::Optional,
                trust_server_certificate: true,
                last_used: Some(1_761_040_833_937),
                ssms_version: "20.0".into(),
            }]
        );
    }

    #[test]
    fn maps_windows_logins_and_skips_other_kinds() {
        let xml = user_settings(&[
            server(r"srv01\SQL2022", 0, "", OCTOBER, &[("EC", "True")]),
            server("azure.example.net", 5, "someone@example.com", OCTOBER, &[]),
        ]);
        let found = read_user_settings(&xml, "21.0");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].authentication, Authentication::Windows);
        assert_eq!(found[0].encrypt, Encrypt::Mandatory);
        assert_eq!(found[0].default_database, None);
    }

    #[test]
    fn ignores_other_server_types_and_bad_files() {
        let analysis = user_settings(&[server("olap01", 0, "", OCTOBER, &[])]).replace(
            &format!("<ServerType>{DATABASE_ENGINE}</ServerType>"),
            "<ServerType>3d5cb4e9-0e1b-4c46-b70f-6bf2d05b5bf3</ServerType>",
        );
        assert!(read_user_settings(&analysis, "21.0").is_empty());
        assert!(read_user_settings("not xml", "21.0").is_empty());
    }

    #[test]
    fn merges_versions_keeping_the_latest_use_of_each_login() {
        let dir = tempfile::tempdir().unwrap();
        for (version, servers) in [
            ("20.0", vec![server("10.0.0.5", 1, "SA", OCTOBER, &[]), server("10.0.0.9", 1, "app", OCTOBER, &[])]),
            ("21.0", vec![server("10.0.0.5", 1, "sa", JUNE, &[("TSC", "True")])]),
            ("22.0", vec![]),
        ] {
            fs::create_dir(dir.path().join(version)).unwrap();
            fs::write(dir.path().join(version).join("UserSettings.xml"), user_settings(&servers)).unwrap();
        }
        let found = discover(dir.path());
        let summary: Vec<_> = found
            .iter()
            .map(|c| (c.server.as_str(), c.ssms_version.as_str(), c.trust_server_certificate))
            .collect();
        assert_eq!(summary, [("10.0.0.5", "21.0", true), ("10.0.0.9", "20.0", false)]);
    }

    #[test]
    fn finds_nothing_without_ssms() {
        assert!(discover(Path::new("does-not-exist")).is_empty());
    }
}
