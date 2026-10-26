//! Object Explorer queries against the SQL Server from `docker-compose.yml`:
//!
//! ```text
//! docker compose up -d --wait
//! cargo test -p quervio-core --test catalog -- --ignored
//! ```

use quervio_core::catalog::{self, CatalogItem, ObjectFolder, TableFolder};
use quervio_core::connection::Authentication;
use quervio_core::scripting;
use quervio_core::session::Session;

mod common;
use common::{password, run_scripts, saved_connection, TestDatabase};

const DATABASE: &str = "Quervio Tests]Catalog";

/// Tests that recreate the shared test database take turns.
static DATABASE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A database with one of every Object the Object Explorer lists, dropped at
/// the end of the test. Its name has a space and a `]` to prove names are
/// quoted.
async fn create_test_database() -> TestDatabase {
    TestDatabase::create(
        DATABASE,
        "EXEC('CREATE SCHEMA sales');
         CREATE TABLE sales.Customer (
             CustomerId int IDENTITY PRIMARY KEY,
             Name nvarchar(100) NOT NULL,
             Notes nvarchar(max) NULL,
             Balance decimal(18, 2) NOT NULL DEFAULT 0,
             Email varchar(200) NULL CONSTRAINT UQ_Customer_Email UNIQUE,
             CONSTRAINT CK_Customer_Balance CHECK (Balance >= 0)
         );
         CREATE TABLE sales.[Order] (
             OrderId bigint PRIMARY KEY NONCLUSTERED,
             CustomerId int NOT NULL CONSTRAINT FK_Order_Customer REFERENCES sales.Customer (CustomerId) ON DELETE CASCADE,
             PlacedAt datetime2(3) NOT NULL
         );
         CREATE CLUSTERED INDEX IX_Order_PlacedAt ON sales.[Order] (PlacedAt);
         EXEC('CREATE TRIGGER sales.TR_Order_Audit ON sales.[Order] AFTER INSERT AS SET NOCOUNT ON;');
         EXEC('CREATE VIEW sales.BigSpenders AS SELECT CustomerId, Name FROM sales.Customer WHERE Balance > 1000');
         EXEC('CREATE PROCEDURE dbo.usp_Touch AS SELECT 1');
         EXEC('CREATE FUNCTION dbo.fn_Double (@x int) RETURNS int AS BEGIN RETURN @x * 2 END');
         EXEC('CREATE FUNCTION dbo.fn_Customers () RETURNS TABLE AS RETURN SELECT CustomerId FROM sales.Customer');",
    )
    .await
}

async fn open() -> Session {
    Session::open(&saved_connection(), password(), "Quervio tests")
        .await
        .expect("open session")
}

fn names(items: &[CatalogItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| match &item.schema {
            Some(schema) => format!("{schema}.{}", item.name),
            None => item.name.clone(),
        })
        .collect()
}

fn details(items: &[CatalogItem]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|item| (item.name.clone(), item.detail.clone().unwrap_or_default()))
        .collect()
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn walks_the_object_explorer_tree() {
    let _turn = DATABASE_LOCK.lock().await;
    let _database = create_test_database().await;
    let mut session = open().await;

    let info = session.server_info().await.unwrap();
    assert_eq!(info.database, "master");
    assert!(info.version.starts_with("16."), "{}", info.version);

    let databases = catalog::databases(&mut session).await.unwrap();
    let master = databases.iter().find(|d| d.name == "master").unwrap();
    assert!(master.system);
    let ours = databases.iter().find(|d| d.name == DATABASE).unwrap();
    assert!(!ours.system);

    let tables = catalog::objects(&mut session, DATABASE, ObjectFolder::Tables)
        .await
        .unwrap();
    assert_eq!(names(&tables), ["sales.Customer", "sales.Order"]);

    let views = catalog::objects(&mut session, DATABASE, ObjectFolder::Views)
        .await
        .unwrap();
    assert_eq!(names(&views), ["sales.BigSpenders"]);

    let procedures = catalog::objects(&mut session, DATABASE, ObjectFolder::StoredProcedures)
        .await
        .unwrap();
    assert_eq!(names(&procedures), ["dbo.usp_Touch"]);

    let functions = catalog::objects(&mut session, DATABASE, ObjectFolder::Functions)
        .await
        .unwrap();
    assert_eq!(
        details(&functions),
        [
            ("fn_Customers".into(), "Table-valued".into()),
            ("fn_Double".into(), "Scalar".into()),
        ]
    );

    let customer = tables[0].object_id.unwrap();
    let order = tables[1].object_id.unwrap();

    let columns = catalog::table_children(&mut session, DATABASE, customer, TableFolder::Columns)
        .await
        .unwrap();
    assert_eq!(
        details(&columns),
        [
            ("CustomerId".into(), "PK, int, not null".into()),
            ("Name".into(), "nvarchar(100), not null".into()),
            ("Notes".into(), "nvarchar(max), null".into()),
            ("Balance".into(), "decimal(18, 2), not null".into()),
            ("Email".into(), "varchar(200), null".into()),
        ]
    );

    let order_columns =
        catalog::table_children(&mut session, DATABASE, order, TableFolder::Columns)
            .await
            .unwrap();
    assert_eq!(
        order_columns[1].detail.as_deref(),
        Some("FK, int, not null")
    );
    assert_eq!(
        order_columns[2].detail.as_deref(),
        Some("datetime2(3), not null")
    );

    let keys = catalog::table_children(&mut session, DATABASE, order, TableFolder::Keys)
        .await
        .unwrap();
    let key_kinds: Vec<_> = keys.iter().map(|k| k.detail.clone().unwrap()).collect();
    assert_eq!(key_kinds.len(), 2);
    assert!(key_kinds.contains(&"Primary key".into()));
    assert!(
        keys.iter()
            .any(|k| k.name == "FK_Order_Customer" && k.detail.as_deref() == Some("Foreign key"))
    );

    let customer_keys =
        catalog::table_children(&mut session, DATABASE, customer, TableFolder::Keys)
            .await
            .unwrap();
    assert!(
        customer_keys
            .iter()
            .any(|k| k.name == "UQ_Customer_Email" && k.detail.as_deref() == Some("Unique"))
    );

    let indexes = catalog::table_children(&mut session, DATABASE, order, TableFolder::Indexes)
        .await
        .unwrap();
    assert!(
        indexes
            .iter()
            .any(|i| i.name == "IX_Order_PlacedAt" && i.detail.as_deref() == Some("Clustered"))
    );
    assert!(
        indexes
            .iter()
            .any(|i| i.detail.as_deref() == Some("Nonclustered, unique"))
    );

    let triggers = catalog::table_children(&mut session, DATABASE, order, TableFolder::Triggers)
        .await
        .unwrap();
    assert_eq!(names(&triggers), ["TR_Order_Audit"]);

    let view_columns = catalog::table_children(
        &mut session,
        DATABASE,
        views[0].object_id.unwrap(),
        TableFolder::Columns,
    )
    .await
    .unwrap();
    assert_eq!(names(&view_columns), ["CustomerId", "Name"]);

    session.close().await.unwrap();
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn wrong_password_is_a_clear_error() {
    let error = Session::open(&saved_connection(), Some("wrong".into()), "Quervio tests")
        .await
        .err()
        .expect("login must fail");
    assert!(error.to_string().contains("Login failed"), "{error}");
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn sql_login_without_a_password_is_refused_before_connecting() {
    let error = Session::open(&saved_connection(), None, "Quervio tests")
        .await
        .err()
        .expect("must fail");
    assert!(error.to_string().contains("no password stored"), "{error}");
    assert!(matches!(
        saved_connection().authentication,
        Authentication::Sql { .. }
    ));
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn bare_localhost_without_a_local_instance_explains_itself() {
    let mut connection = saved_connection();
    connection.server = "localhost".into();
    let started = std::time::Instant::now();
    let error = Session::open(&connection, password(), "Quervio tests")
        .await
        .err()
        .expect("no local instance on this machine");
    assert!(error.to_string().contains("host,port"), "{error}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "took {:?}",
        started.elapsed()
    );
}

/// Scripts a table, runs the script in a fresh database and scripts the
/// copy: both must match, so the CREATE TABLE is complete and valid.
#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn create_table_scripts_round_trip() {
    let _turn = DATABASE_LOCK.lock().await;
    let _database = create_test_database().await;
    let mut session = open().await;
    let tables = catalog::objects(&mut session, DATABASE, ObjectFolder::Tables)
        .await
        .unwrap();
    let mut originals = Vec::new();
    for table in &tables {
        let script = scripting::create_table(&mut session, DATABASE, table.object_id.unwrap())
            .await
            .unwrap();
        originals.push(script);
    }
    assert!(
        originals[0].contains("IDENTITY(1, 1) NOT NULL"),
        "{}",
        originals[0]
    );
    assert!(originals[0].contains("DEFAULT ((0))"), "{}", originals[0]);
    assert!(
        originals[0].contains("CONSTRAINT [CK_Customer_Balance] CHECK ([Balance]>=(0))"),
        "{}",
        originals[0]
    );
    assert!(
        originals[0].contains("CONSTRAINT [UQ_Customer_Email] UNIQUE NONCLUSTERED ([Email])"),
        "{}",
        originals[0]
    );
    assert!(
        originals[1].contains(
            "CONSTRAINT [FK_Order_Customer] FOREIGN KEY ([CustomerId]) REFERENCES [sales].[Customer] ([CustomerId]) ON DELETE CASCADE"
        ),
        "{}",
        originals[1]
    );

    const COPY: &str = "Quervio Tests]Scripted";
    let _copy = TestDatabase::create(COPY, "EXEC('CREATE SCHEMA sales');").await;
    for script in &originals {
        run_scripts(&[&format!("USE [Quervio Tests]]Scripted];\n{script}")]).await;
    }

    let copies = catalog::objects(&mut session, COPY, ObjectFolder::Tables)
        .await
        .unwrap();
    for (copy, original) in copies.iter().zip(&originals) {
        let script = scripting::create_table(&mut session, COPY, copy.object_id.unwrap())
            .await
            .unwrap();
        assert_eq!(&script, original);
    }
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn modules_script_as_create_and_alter() {
    let _turn = DATABASE_LOCK.lock().await;
    let _database = create_test_database().await;
    let mut session = open().await;
    let procedures = catalog::objects(&mut session, DATABASE, ObjectFolder::StoredProcedures)
        .await
        .unwrap();
    let id = procedures[0].object_id.unwrap();
    let definition = scripting::module_definition(&mut session, DATABASE, id)
        .await
        .unwrap();
    assert_eq!(definition, "CREATE PROCEDURE dbo.usp_Touch AS SELECT 1");
    let alter = scripting::as_alter(&definition);
    run_scripts(&[&format!(
        "USE [Quervio Tests]]Catalog];\nEXEC('{}')",
        alter.replace('\'', "''")
    )])
    .await;

    let tables = catalog::objects(&mut session, DATABASE, ObjectFolder::Tables)
        .await
        .unwrap();
    let select = scripting::select_top(&mut session, DATABASE, tables[0].object_id.unwrap(), 1000)
        .await
        .unwrap();
    assert_eq!(
        select,
        "SELECT TOP (1000)\n      [CustomerId]\n     ,[Name]\n     ,[Notes]\n     ,[Balance]\n     ,[Email]\n  FROM [sales].[Customer];\n"
    );
}
