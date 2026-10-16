//! Automatic updates driven by the GitHub releases.
//!
//! The updater plugin checks the static `latest.json` manifest published
//! with each stable GitHub release and installs the signed bundle. The
//! whole flow stays behind Rust commands — the webview never reaches the
//! updater directly — matching the app's IPC conventions (the plugin needs
//! no webview-side permission).
//!
//! Two commands: [`check_update`] fetches the manifest, keeps the pending
//! [`Update`] in state and returns its metadata; [`install_update`]
//! downloads and installs it, streaming progress over a channel, then
//! relaunches the app.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{err, AppError};
use crate::locks::MutexExt;

/// The update found by [`check_update`], waiting for [`install_update`].
/// The plugin's `Update` is not `Clone`, so it is moved here between the
/// two commands.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Metadata sent to the frontend when a newer release is available.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    /// Release notes (the release body), when the manifest carries them.
    pub notes: Option<String>,
    /// Publication date (RFC 3339), when the manifest carries it.
    pub date: Option<String>,
}

/// Download progress streamed to the frontend over a channel. The wire
/// format (`{ event, data }`, camelCase fields) is what js/core/updater.js
/// reads; see the unit test at the bottom of this file.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum DownloadEvent {
    /// First event: the total size to download, when the server reports it.
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    /// A chunk was received; `chunk_length` is its size in bytes.
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    /// The download finished; the install follows.
    Finished,
}

/// Checks the configured endpoint for a newer release. Returns `None` when
/// the app is up to date; the pending update is kept in state otherwise so
/// [`install_update`] can install it without a second request.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, AppError> {
    let update = app
        .updater()
        .map_err(|_| err("update_check_failed"))?
        .check()
        .await
        .map_err(|_| err("update_check_failed"))?;

    let metadata = update.as_ref().map(|u| UpdateMetadata {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *pending.0.lock_safe() = update;
    Ok(metadata)
}

/// Downloads and installs the pending update, then relaunches the app. On
/// Windows the app is exited by the installer before this returns; on the
/// other platforms `restart` replaces the running process.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), AppError> {
    // The guard is a temporary of this statement: released before the
    // first await, so nothing is held across the download.
    let update = pending
        .0
        .lock_safe()
        .take()
        .ok_or_else(|| err("no_pending_update"))?;

    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|_| err("update_install_failed"))?;

    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The channel payload is an IPC contract with js/core/updater.js: the
    /// tag is `event`, the payload sits under `data`, and the fields are
    /// camelCase. Changing any of these breaks the frontend progress UI.
    #[test]
    fn download_event_wire_format_matches_the_frontend() {
        let started = serde_json::to_value(DownloadEvent::Started {
            content_length: Some(42),
        })
        .unwrap();
        assert_eq!(
            started,
            serde_json::json!({ "event": "started", "data": { "contentLength": 42 } })
        );

        let progress = serde_json::to_value(DownloadEvent::Progress { chunk_length: 7 }).unwrap();
        assert_eq!(
            progress,
            serde_json::json!({ "event": "progress", "data": { "chunkLength": 7 } })
        );

        let finished = serde_json::to_value(DownloadEvent::Finished).unwrap();
        assert_eq!(finished, serde_json::json!({ "event": "finished" }));
    }
}
