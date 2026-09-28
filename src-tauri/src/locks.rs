//! Lock-ordering invariant for the shared state.
//!
//! Several paths lock two states together: `ImageState::processed` (the
//! image the pixel sequences are built from) and `SynthState::synths`
//! (the synths being stepped or edited). The metronome tick loop holds
//! both across a whole tick, and the `set_synth_*` commands need both to
//! remap the playhead. To rule out an AB-BA deadlock between them, the
//! order is **always image first, then synths**.
//!
//! This module is the single place that enforces the order: commands that
//! need both go through [`with_locked_synth`]. The metronome tick loop
//! locks them by hand (it iterates every synth under the image lock) and
//! carries a comment pointing here.

use image::DynamicImage;

use crate::error::{err, AppError};
use crate::state::{ImageState, Synth, SynthState};

/// Runs `f` with the synth `id` and the processed image (if any), holding
/// `ImageState::processed` then `SynthState::synths` — the mandated order.
/// Returns `synth_not_found` when the id is unknown.
pub fn with_locked_synth<R>(
    image_state: &ImageState,
    synth_state: &SynthState,
    id: u32,
    f: impl FnOnce(&mut Synth, Option<&DynamicImage>) -> R,
) -> Result<R, AppError> {
    let image = image_state.processed.lock().unwrap();
    let mut synths = synth_state.synths.lock().unwrap();
    let synth = synths
        .get_mut(&id)
        .ok_or_else(|| err("synth_not_found").with_param("id", id))?;
    Ok(f(synth, image.as_ref()))
}
