use crate::database::Database;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, OwnedMutexGuard};

/// Actual native read/modify/write exclusion. There is no headless ProxyService.
#[derive(Clone)]
pub struct AppSwitchLocks(Arc<HashMap<&'static str, Arc<Mutex<()>>>>);
impl Default for AppSwitchLocks {
    fn default() -> Self {
        Self(Arc::new(crate::host_context::APP_IDS.iter()
            .map(|id| (*id, Arc::new(Mutex::new(())))).collect()))
    }
}
impl AppSwitchLocks {
    pub async fn lock_switch_for_app(&self, app: &str) -> OwnedMutexGuard<()> {
        self.0.get(app).expect("validated native application").clone().lock_owned().await
    }
}
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub app_switch_locks: AppSwitchLocks,
}
impl AppState {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db, app_switch_locks: AppSwitchLocks::default() }
    }
}
