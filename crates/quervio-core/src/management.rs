//! Version-aware, read-only management queries. Never shares an editor Session.
use crate::{catalog::quote_name, error::Result, session::Session};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub state: &'static str,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub version: String,
    pub major_version: u32,
    pub edition: String,
    pub engine_edition: u32,
    pub database: String,
    pub features: std::collections::BTreeMap<String, Feature>,
}

pub fn literal(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Resource {
    Properties,
    Objects,
    ObjectProperties { object_id: i64 },
    ServerTriggers,
    Columns { object_id: i64 },
    Parameters { object_id: i64 },
    Definition { object_id: i64 },
    Relations,
    Activity,
    Waits,
    Io,
    Cpu,
    ExpensiveQueries,
    QueryStoreOptions,
    QueryStoreQueries { minutes: u32 },
    QueryStoreRegressions { minutes: u32 },
    QueryStoreHistory { query_id: i64, minutes: u32 },
    QueryStorePlans { query_id: i64 },
    QueryStorePlan { plan_id: i64 },
    Events,
    EventData { name: String },
    Xel { path: String },
    Backups,
    BackupHeader { path: String },
    BackupFiles { path: String },
    Jobs,
    JobSteps { job_id: String },
    JobHistory { job_id: String },
    Alerts,
    Operators,
    Principals { server: bool },
    Roles { server: bool },
    Permissions { server: bool },
    EffectivePermissions { server: bool },
    Audits,
    AuditSpecifications { server: bool },
    AuditData { path: String },
    Encryption,
    Certificates,
    ColumnKeys,
    Live { session_id: u32 },
}

impl Resource {
    pub fn sql(&self, major: u32, azure: bool) -> String {
        match self {
            Self::ObjectProperties{object_id}=>format!("SELECT s.name AS [schema],o.name,o.type_desc,m.definition,m.is_schema_bound,(SELECT COUNT(*) FROM sys.indexes i WHERE i.object_id=o.object_id AND i.index_id>0) AS index_count FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.object_id={object_id} UNION ALL SELECT NULL,t.name,N'SQL_TRIGGER',m.definition,m.is_schema_bound,0 FROM sys.triggers t LEFT JOIN sys.sql_modules m ON m.object_id=t.object_id WHERE t.parent_class=0 AND t.object_id={object_id}"),
            Self::EffectivePermissions{server}=>format!("SELECT entity_name,subentity_name,permission_name FROM sys.fn_my_permissions(NULL,'{}') ORDER BY permission_name",if *server{"SERVER"}else{"DATABASE"}),
            Self::QueryStoreHistory{query_id,minutes}=>format!("SELECT p.plan_id,i.start_time,i.end_time,SUM(rs.count_executions) AS executions,SUM(rs.avg_duration*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS avg_duration_us,SUM(rs.avg_cpu_time*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS avg_cpu_us FROM sys.query_store_plan p JOIN sys.query_store_runtime_stats rs ON rs.plan_id=p.plan_id JOIN sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id=rs.runtime_stats_interval_id WHERE p.query_id={query_id} AND i.end_time>DATEADD(minute,-{},SYSDATETIMEOFFSET()) GROUP BY p.plan_id,i.start_time,i.end_time ORDER BY i.start_time,p.plan_id",minutes.clamp(&1,&525600)),
            Self::QueryStoreRegressions{minutes}=>format!("WITH samples AS (SELECT q.query_id,qt.query_sql_text,CASE WHEN i.end_time>DATEADD(minute,-{m},SYSDATETIMEOFFSET()) THEN 1 ELSE 0 END AS period,rs.avg_duration,rs.count_executions FROM sys.query_store_query q JOIN sys.query_store_query_text qt ON qt.query_text_id=q.query_text_id JOIN sys.query_store_plan p ON p.query_id=q.query_id JOIN sys.query_store_runtime_stats rs ON rs.plan_id=p.plan_id JOIN sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id=rs.runtime_stats_interval_id WHERE i.end_time>DATEADD(minute,-{twice},SYSDATETIMEOFFSET())),metrics AS (SELECT query_id,query_sql_text,SUM(CASE WHEN period=0 THEN avg_duration*count_executions END)/NULLIF(SUM(CASE WHEN period=0 THEN count_executions END),0) AS previous_duration_us,SUM(CASE WHEN period=1 THEN avg_duration*count_executions END)/NULLIF(SUM(CASE WHEN period=1 THEN count_executions END),0) AS current_duration_us FROM samples GROUP BY query_id,query_sql_text) SELECT TOP(200) query_id,query_sql_text,previous_duration_us,current_duration_us,current_duration_us/NULLIF(previous_duration_us,0) AS duration_ratio FROM metrics WHERE current_duration_us>previous_duration_us*1.25 ORDER BY duration_ratio DESC",m=minutes.clamp(&1,&262800),twice=minutes.clamp(&1,&262800)*2),
            Self::ServerTriggers => "SELECT t.name,t.object_id,t.is_disabled,m.definition FROM sys.server_triggers t LEFT JOIN sys.server_sql_modules m ON m.object_id=t.object_id ORDER BY t.name".into(),
            Self::Properties => "SELECT name, database_id, state_desc, recovery_model_desc, compatibility_level, collation_name, is_read_only FROM sys.databases WHERE name=DB_NAME()".into(),
            Self::Objects => "SELECT s.name AS [schema], o.name, o.object_id, o.type_desc, o.modify_date FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.is_ms_shipped=0 ORDER BY s.name,o.name".into(),
            Self::Columns { object_id } => format!("SELECT c.column_id,c.name,t.name AS type,c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,c.is_computed,dc.name AS default_name,dc.definition AS default_expression,cc.definition AS computed_expression,CONVERT(nvarchar(128),ic.seed_value) AS identity_seed,CONVERT(nvarchar(128),ic.increment_value) AS identity_increment,c.collation_name FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id WHERE c.object_id={object_id} ORDER BY c.column_id"),
            Self::Parameters { object_id } => format!("SELECT p.name,t.name AS type,p.max_length,p.precision,p.scale,p.is_output FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id WHERE p.object_id={object_id} ORDER BY p.parameter_id"),
            Self::Definition { object_id } => format!("SELECT definition FROM sys.sql_modules WHERE object_id={object_id}"),
            Self::Relations => "SELECT fk.name,ps.name AS parent_schema,pt.name AS parent_table,pc.name AS parent_column,rs.name AS referenced_schema,rt.name AS referenced_table,rc.name AS referenced_column,fkc.constraint_column_id,fk.delete_referential_action_desc,fk.update_referential_action_desc FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id JOIN sys.tables pt ON pt.object_id=fkc.parent_object_id JOIN sys.schemas ps ON ps.schema_id=pt.schema_id JOIN sys.columns pc ON pc.object_id=pt.object_id AND pc.column_id=fkc.parent_column_id JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=rt.schema_id JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fkc.referenced_column_id ORDER BY fk.name,fkc.constraint_column_id".into(),
            // User sessions, idle ones included: a sleeping session holding a transaction is
            // what blocks others. Blocked and blocking sessions come first.
            Self::Activity => "SELECT s.session_id,s.login_name,s.host_name,s.program_name,DB_NAME(COALESCE(r.database_id,s.database_id)) AS database_name,COALESCE(r.status,s.status) AS status,r.command,r.blocking_session_id,s.open_transaction_count,r.wait_type,r.wait_time AS wait_ms,COALESCE(r.cpu_time,s.cpu_time) AS cpu_ms,r.total_elapsed_time AS elapsed_ms,COALESCE(r.reads,s.reads) AS reads,COALESCE(r.writes,s.writes) AS writes,COALESCE(r.logical_reads,s.logical_reads) AS logical_reads,t.text FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id=s.session_id LEFT JOIN sys.dm_exec_connections c ON c.session_id=s.session_id AND c.parent_connection_id IS NULL OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle,c.most_recent_sql_handle)) t WHERE s.is_user_process=1 AND s.session_id<>@@SPID ORDER BY CASE WHEN r.blocking_session_id>0 OR EXISTS(SELECT 1 FROM sys.dm_exec_requests b WHERE b.blocking_session_id=s.session_id) THEN 0 ELSE 1 END,s.open_transaction_count DESC,s.session_id".into(),
            Self::Waits => "SELECT TOP (100) wait_type,waiting_tasks_count,wait_time_ms,signal_wait_time_ms FROM sys.dm_os_wait_stats WHERE wait_time_ms>0 ORDER BY wait_time_ms DESC".into(),
            Self::Io => "SELECT DB_NAME(v.database_id) AS database_name,m.name,m.physical_name,v.num_of_reads,v.num_of_writes,v.num_of_bytes_read,v.num_of_bytes_written,v.io_stall_read_ms,v.io_stall_write_ms,v.sample_ms FROM sys.dm_io_virtual_file_stats(NULL,NULL) v LEFT JOIN sys.master_files m ON m.database_id=v.database_id AND m.file_id=v.file_id ORDER BY v.io_stall DESC".into(),
            Self::Cpu => "SELECT TOP (60) [timestamp] AS sample_tick,CONVERT(xml,record).value('(Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int') AS sql_process_cpu_percent,CONVERT(xml,record).value('(Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int') AS system_idle_percent FROM sys.dm_os_ring_buffers WHERE ring_buffer_type=N'RING_BUFFER_SCHEDULER_MONITOR' AND record LIKE '%<SystemHealth>%' ORDER BY [timestamp] DESC".into(),
            Self::ExpensiveQueries => "SELECT TOP (100) qs.execution_count,qs.total_worker_time AS total_cpu_us,qs.total_elapsed_time AS total_elapsed_us,qs.total_logical_reads,qs.total_logical_writes,qs.last_execution_time,t.text FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t ORDER BY qs.total_worker_time DESC".into(),
            Self::QueryStoreOptions => "SELECT actual_state_desc,desired_state_desc,readonly_reason,current_storage_size_mb,max_storage_size_mb,query_capture_mode_desc FROM sys.database_query_store_options".into(),
            Self::QueryStoreQueries { minutes } => format!("SELECT TOP (200) q.query_id,qt.query_sql_text,SUM(rs.count_executions) AS executions,SUM(rs.avg_duration*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS avg_duration_us,SUM(rs.avg_cpu_time*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS avg_cpu_us,SUM(rs.avg_logical_io_reads*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS avg_logical_reads,COUNT(DISTINCT p.plan_id) AS plans FROM sys.query_store_query q JOIN sys.query_store_query_text qt ON qt.query_text_id=q.query_text_id JOIN sys.query_store_plan p ON p.query_id=q.query_id JOIN sys.query_store_runtime_stats rs ON rs.plan_id=p.plan_id JOIN sys.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id=rs.runtime_stats_interval_id WHERE i.end_time>DATEADD(minute,-{},SYSDATETIMEOFFSET()) GROUP BY q.query_id,qt.query_sql_text ORDER BY avg_duration_us DESC", minutes.clamp(&1,&525600)),
            Self::QueryStorePlans { query_id } => format!("SELECT p.plan_id,p.query_id,p.is_forced_plan,p.force_failure_count,p.last_force_failure_reason_desc,p.last_execution_time,SUM(rs.count_executions) AS executions,SUM(rs.avg_duration*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS avg_duration_us FROM sys.query_store_plan p LEFT JOIN sys.query_store_runtime_stats rs ON rs.plan_id=p.plan_id WHERE p.query_id={query_id} GROUP BY p.plan_id,p.query_id,p.is_forced_plan,p.force_failure_count,p.last_force_failure_reason_desc,p.last_execution_time ORDER BY p.plan_id"),
            Self::QueryStorePlan { plan_id } => format!("SELECT query_plan FROM sys.query_store_plan WHERE plan_id={plan_id}"),
            Self::Events => if azure { "SELECT s.name,s.event_session_id AS session_id,CASE WHEN d.name IS NULL THEN 0 ELSE 1 END AS running FROM sys.database_event_sessions s LEFT JOIN sys.dm_xe_database_sessions d ON d.name=s.name" } else { "SELECT s.name,s.event_session_id AS session_id,CASE WHEN d.name IS NULL THEN 0 ELSE 1 END AS running FROM sys.server_event_sessions s LEFT JOIN sys.dm_xe_sessions d ON d.name=s.name" }.into(),
            Self::EventData { name } => format!("SELECT CAST(t.target_data AS nvarchar(max)) AS target_data FROM {} s JOIN {} t ON t.event_session_address=s.address WHERE s.name={} AND t.target_name=N'ring_buffer'", if azure {"sys.dm_xe_database_sessions"} else {"sys.dm_xe_sessions"}, if azure {"sys.dm_xe_database_session_targets"} else {"sys.dm_xe_session_targets"}, literal(name)),
            Self::Xel { path } => format!("SELECT TOP (1000) object_name,CAST(event_data AS xml).value('(/event/@timestamp)[1]','datetime2') AS timestamp_utc,CAST(event_data AS nvarchar(max)) AS event_data,file_name,file_offset FROM sys.fn_xe_file_target_read_file({},NULL,NULL,NULL) ORDER BY timestamp_utc DESC",literal(path)),
            Self::Backups => "SELECT TOP (200) b.backup_set_id,b.database_name,b.type,b.backup_start_date,b.backup_finish_date,b.first_lsn,b.last_lsn,b.database_backup_lsn,b.is_copy_only,m.physical_device_name FROM msdb.dbo.backupset b JOIN msdb.dbo.backupmediafamily m ON m.media_set_id=b.media_set_id WHERE b.database_name=DB_NAME() ORDER BY b.backup_finish_date DESC".into(),
            Self::BackupHeader { path } => format!("RESTORE HEADERONLY FROM {}={}", device(path),literal(path)),
            Self::BackupFiles { path } => format!("RESTORE FILELISTONLY FROM {}={}", device(path),literal(path)),
            Self::Jobs => "SELECT j.job_id,j.name,j.enabled,j.description,s.name AS owner FROM msdb.dbo.sysjobs j LEFT JOIN sys.server_principals s ON s.sid=j.owner_sid ORDER BY j.name".into(),
            Self::JobSteps { job_id } => format!("SELECT step_id,step_name,subsystem,database_name,command,on_success_action,on_success_step_id,on_fail_action,on_fail_step_id FROM msdb.dbo.sysjobsteps WHERE job_id=CONVERT(uniqueidentifier,{}) ORDER BY step_id",literal(job_id)),
            Self::JobHistory { job_id } => format!("SELECT TOP (200) instance_id,step_id,step_name,run_status,run_date,run_time,run_duration,message FROM msdb.dbo.sysjobhistory WHERE job_id=CONVERT(uniqueidentifier,{}) ORDER BY instance_id DESC",literal(job_id)),
            Self::Alerts => "SELECT id,name,enabled,message_id,severity,performance_condition,job_id,delay_between_responses FROM msdb.dbo.sysalerts ORDER BY name".into(),
            Self::Operators => "SELECT id,name,enabled,email_address,pager_address,netsend_address FROM msdb.dbo.sysoperators ORDER BY name".into(),
            Self::Principals { server } => format!("SELECT principal_id,name,type_desc,is_fixed_role,{} FROM {} WHERE type<>'R' ORDER BY name",if *server {"is_disabled"} else {"default_schema_name"},if *server {"sys.server_principals"} else {"sys.database_principals"}),
            Self::Roles { server } => {let scope=if *server {"server"} else {"database"};format!("SELECT r.name AS role_name,m.name AS member_name FROM sys.{scope}_principals r LEFT JOIN sys.{scope}_role_members rm ON rm.role_principal_id=r.principal_id LEFT JOIN sys.{scope}_principals m ON m.principal_id=rm.member_principal_id WHERE r.type='R' ORDER BY r.name,m.name")},
            Self::Permissions { server } => {let scope=if *server {"server"} else {"database"};format!("SELECT p.name AS principal_name,perm.class_desc,perm.major_id,perm.permission_name,perm.state_desc FROM sys.{scope}_permissions perm JOIN sys.{scope}_principals p ON p.principal_id=perm.grantee_principal_id ORDER BY p.name,perm.class_desc,perm.major_id,perm.permission_name")},
            Self::Audits => "SELECT a.name,a.audit_id,a.type_desc,a.is_state_enabled,f.log_file_path FROM sys.server_audits a LEFT JOIN sys.server_file_audits f ON f.audit_id=a.audit_id ORDER BY a.name".into(),
            Self::AuditSpecifications { server } => {let scope=if *server {"server"} else {"database"};format!("SELECT s.name,s.is_state_enabled,d.audit_action_name,d.audited_result FROM sys.{scope}_audit_specifications s LEFT JOIN sys.{scope}_audit_specification_details d ON d.{scope}_specification_id=s.{scope}_specification_id ORDER BY s.name")},
            Self::AuditData { path } => format!("SELECT TOP (1000) event_time,action_id,succeeded,session_server_principal_name,database_name,schema_name,object_name,statement FROM sys.fn_get_audit_file({},DEFAULT,DEFAULT) ORDER BY event_time DESC",literal(path)),
            Self::Encryption => "SELECT DB_NAME(database_id) AS database_name,encryption_state,percent_complete,key_algorithm,key_length,encryptor_type FROM sys.dm_database_encryption_keys".into(),
            Self::Certificates => "SELECT name,subject,expiry_date,start_date,pvt_key_encryption_type_desc FROM sys.certificates ORDER BY name".into(),
            Self::ColumnKeys => "SELECT k.name,k.column_encryption_key_id,v.column_master_key_id,m.name AS master_key,m.key_store_provider_name,m.key_path,v.encryption_algorithm_name FROM sys.column_encryption_keys k LEFT JOIN sys.column_encryption_key_values v ON v.column_encryption_key_id=k.column_encryption_key_id LEFT JOIN sys.column_master_keys m ON m.column_master_key_id=v.column_master_key_id ORDER BY k.name".into(),
            Self::Live { session_id } => if major>=13 {format!("SELECT CAST(query_plan AS nvarchar(max)) AS query_plan FROM sys.dm_exec_query_statistics_xml({session_id})")} else {format!("SELECT node_id,physical_operator_name,SUM(row_count) AS actual_rows,SUM(estimate_row_count) AS estimated_rows,SUM(elapsed_time_ms) AS elapsed_ms FROM sys.dm_exec_query_profiles WHERE session_id={session_id} GROUP BY node_id,physical_operator_name")},
        }
    }
}

fn device(path: &str) -> &'static str {
    if path.starts_with("https://") {
        "URL"
    } else {
        "DISK"
    }
}

pub async fn capabilities(session: &mut Session) -> Result<ServerCapabilities> {
    let data=session.query_table("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)),CAST(SERVERPROPERTY('Edition') AS nvarchar(256)),CAST(SERVERPROPERTY('EngineEdition') AS int),DB_NAME(),HAS_PERMS_BY_NAME(NULL,NULL,'VIEW SERVER STATE'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','SHOWPLAN'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER'),IS_SRVROLEMEMBER('sysadmin')",1).await?;
    let row = &data.rows[0];
    let get = |i: usize| row[i].clone().unwrap_or_default();
    let version = get(0);
    let major_version = version
        .split('.')
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let engine_edition = get(2).parse().unwrap_or(0);
    let azure = engine_edition == 5;
    let admin = get(7) == "1";
    let mut features = std::collections::BTreeMap::new();
    let mut add = |name: &str, supported: bool, allowed: bool| {
        features.insert(
            name.into(),
            Feature {
                state: if !supported {
                    "unsupported"
                } else if !allowed {
                    "denied"
                } else {
                    "available"
                },
                reason: if !supported {
                    "Not provided by this server version, edition or platform.".into()
                } else if !allowed {
                    "The current login does not have the required permission.".into()
                } else {
                    String::new()
                },
            },
        );
    };
    add("plans", true, get(5) == "1");
    add("monitor", true, get(4) == "1" || admin || azure);
    add(
        "live",
        major_version >= 12 || azure,
        get(4) == "1" || admin || azure,
    );
    add("queryStore", major_version >= 13 || azure, true);
    add("agent", !azure && engine_edition != 4, admin);
    add("backup", !azure, true);
    add("events", true, true);
    add("audit", !azure, admin);
    add(
        "tde",
        azure
            || engine_edition == 3
            || engine_edition == 8
            || (major_version >= 15 && engine_edition == 2),
        admin || azure,
    );
    add("alwaysEncrypted", major_version >= 13 || azure, true);
    if major_version >= 13 || azure {
        if let Ok(state) = session
            .query_table(
                "SELECT actual_state_desc FROM sys.database_query_store_options",
                1,
            )
            .await
        {
            if state.rows.first().and_then(|r| r[0].as_deref()) == Some("OFF") {
                features.insert(
                    "queryStore".into(),
                    Feature {
                        state: "disabled",
                        reason: "Query Store is disabled for this database.".into(),
                    },
                );
            }
        }
    }
    Ok(ServerCapabilities {
        version,
        major_version,
        edition: get(1),
        engine_edition,
        database: get(3),
        features,
    })
}

pub async fn read(session: &mut Session, resource: Resource) -> Result<DataTable> {
    let info = session.server_info().await?;
    let major = info
        .version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(11);
    let engine = session
        .query_table("SELECT CAST(SERVERPROPERTY('EngineEdition') AS int)", 1)
        .await?;
    let azure = engine.rows.first().and_then(|r| r[0].as_deref()) == Some("5");
    session.query_table(&resource.sql(major, azure), 1000).await
}

pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_name(schema), quote_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_paths_and_names_are_literals() {
        assert_eq!(literal("a'b"), "N'a''b'");
        assert!(
            Resource::EventData {
                name: "x';DROP TABLE x;--".into()
            }
            .sql(16, false)
            .contains("N'x'';DROP TABLE x;--'")
        );
        assert!(
            Resource::BackupHeader {
                path: "https://store/x.bak".into()
            }
            .sql(16, false)
            .starts_with("RESTORE HEADERONLY FROM URL=")
        );
    }
    #[test]
    fn live_2014_uses_profiles_instead_of_2016_dmf() {
        assert!(
            Resource::Live { session_id: 52 }
                .sql(12, false)
                .contains("sys.dm_exec_query_profiles")
        );
        assert!(
            Resource::Live { session_id: 52 }
                .sql(16, false)
                .contains("sys.dm_exec_query_statistics_xml(52)")
        );
    }
}
