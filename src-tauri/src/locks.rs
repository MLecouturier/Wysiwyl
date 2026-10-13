//! Lock-ordering invariant for the shared state, and poison-tolerant
//! locking.
//!
//! Several paths lock two states together: `ImageState::processed` (the
//! image the pixel sequences are built from) and `SynthState::synths`
//! (the synths being stepped or edited). The metronome tick loop holds
//! both across a whole tick, and the `set_synth_*` commands need both to
//! remap the playhead. To rule out an AB-BA deadlock between them, the
//! order is **always image first, then synths**. `ConfigState::config`
//! is never taken while holding either of them: the metronome reads its
//! configuration snapshot before locking the image.
//!
//! This module is the single place that enforces the order: commands that
//! need both go through [`with_locked_synth`]. The metronome tick loop
//! locks them by hand (it iterates every synth under the image lock) and
//! carries a comment pointing here.
//!
//! Every lock of the crate goes through [`MutexExt::lock_safe`]: a panic
//! while a mutex is held (a bug) must not turn every later command into a
//! panic too. The data behind a poisoned mutex is still structurally
//! valid (plain values, no broken invariant the code relies on), so the
//! guard is recovered instead of propagating the poison.

use std::sync::{Mutex, MutexGuard, PoisonError};

use image::DynamicImage;

use crate::error::{err, AppError};
use crate::state::{ImageState, Synth, SynthState};

/// Poison-tolerant locking (see the module documentation).
pub trait MutexExt<T> {
    /// Locks the mutex, recovering the guard if a previous holder
    /// panicked.
    fn lock_safe(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Runs `f` with the synth `id` and the processed image (if any), holding
/// `ImageState::processed` then `SynthState::synths` — the mandated order.
/// Returns `synth_not_found` when the id is unknown.
pub fn with_locked_synth<R>(
    image_state: &ImageState,
    synth_state: &SynthState,
    id: u32,
    f: impl FnOnce(&mut Synth, Option<&DynamicImage>) -> R,
) -> Result<R, AppError> {
    let image = image_state.processed.lock_safe();
    let mut synths = synth_state.synths.lock_safe();
    let synth = synths
        .get_mut(&id)
        .ok_or_else(|| err("synth_not_found").with_param("id", id))?;
    Ok(f(synth, image.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_safe_recovers_a_poisoned_mutex() {
        let mutex = std::sync::Arc::new(Mutex::new(41));
        let poisoner = mutex.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        assert!(mutex.is_poisoned());
        *mutex.lock_safe() += 1;
        assert_eq!(*mutex.lock_safe(), 42);
    }
}
