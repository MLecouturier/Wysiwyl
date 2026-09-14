use crate::config::ConfigState;
use crate::error::{err, AppError};
use crate::state::ImageState;
use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::State;

#[derive(Serialize)]
pub struct LoadedImageInfo {
    pub base64_png: String,
    pub orig_width: u32,
    pub orig_height: u32,
}

#[derive(Deserialize)]
pub struct AdjustmentParams {
    pub grid_width: u32,
    pub grid_height: Option<u32>, // always None for now: ratio is deduced
    pub contrast: f32,
    pub brightness: i32,
    pub vibrance: f32,
    pub posterize_levels: Option<u8>,
    pub texture: f32,
    pub clarity: f32,
    pub simplify: f32,
    pub auto_levels: bool,
}

pub(crate) fn encode_to_base64_png(img: &DynamicImage) -> Result<String, AppError> {
    let mut buffer = Cursor::new(Vec::new());
    img.write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| err("png_encoding_error").with_param("details", e))?;
    Ok(general_purpose::STANDARD.encode(buffer.into_inner()))
}

/// Packs an image into the raw IPC format consumed by the frontend:
/// an 8-byte header (width and height as little-endian u32) followed by
/// the flat RGBA bytes. Transferred as binary (no PNG encoding, no
/// base64, no JSON), then painted directly on a canvas.
fn rgba_ipc_response(img: &DynamicImage) -> tauri::ipc::Response {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut bytes = Vec::with_capacity(8 + rgba.as_raw().len());
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(rgba.as_raw());
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
pub async fn load_image(
    app_handle: tauri::AppHandle,
    state: State<'_, ImageState>,
    config_state: State<'_, ConfigState>,
) -> Result<LoadedImageInfo, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app_handle
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "bmp", "gif"])
        .blocking_pick_file();

    let path = file_path.ok_or_else(|| err("no_file_selected"))?;

    let path_buf = path
        .as_path()
        .ok_or_else(|| err("invalid_file_path"))?;

    let mut img = image::open(path_buf)
        .map_err(|e| err("image_load_error").with_param("details", e))?;

    // Downscale oversized originals so the app stays responsive
    let max_size = config_state.config.lock().unwrap().max_image_size;
    if max_size > 0 {
        let (w, h) = img.dimensions();
        if w.max(h) > max_size {
            img = img.resize(max_size, max_size, image::imageops::FilterType::Lanczos3);
        }
    }

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;

    *state.original.lock().unwrap() = Some(img.clone());
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: width,
        orig_height: height,
    })
}

#[derive(Deserialize)]
pub struct TransformParams {
    pub rotation: f32,      // fine rotation in degrees (positive = clockwise)
    pub perspective_v: f32, // vertical keystone, fraction of the width, in (-1, 1)
    pub perspective_h: f32, // horizontal keystone, fraction of the height, in (-1, 1)
}

/// Samples `src` at fractional coordinates with bilinear interpolation.
/// Coordinates outside the source yield fully transparent pixels.
fn sample_bilinear(src: &image::RgbaImage, x: f32, y: f32) -> image::Rgba<u8> {
    let (w, h) = src.dimensions();
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= w as f32 || y >= h as f32 {
        return image::Rgba([0, 0, 0, 0]);
    }
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;

    let p00 = src.get_pixel(x0, y0);
    let p10 = src.get_pixel(x1, y0);
    let p01 = src.get_pixel(x0, y1);
    let p11 = src.get_pixel(x1, y1);

    // Bilinear interpolation per channel (alpha included)
    let mut out = [0u8; 4];
    for c in 0..4 {
        let top = p00[c] as f32 * (1.0 - fx) + p10[c] as f32 * fx;
        let bottom = p01[c] as f32 * (1.0 - fx) + p11[c] as f32 * fx;
        out[c] = (top * (1.0 - fy) + bottom * fy).round() as u8;
    }
    image::Rgba(out)
}

/// Rotates `img` by `angle_degrees` about its center (positive = clockwise),
/// expanding the canvas so the whole image fits; the exposed corners are
/// transparent. Inverse mapping with bilinear sampling.
fn rotate_fine(img: &DynamicImage, angle_degrees: f32) -> DynamicImage {
    if angle_degrees == 0.0 {
        return img.clone();
    }

    let src = img.to_rgba8();
    let (w, h) = src.dimensions();
    let (wf, hf) = (w as f32, h as f32);
    let theta = angle_degrees.to_radians();
    let (sin, cos) = theta.sin_cos();

    let out_w = ((wf * cos).abs() + (hf * sin).abs()).round().max(1.0) as u32;
    let out_h = ((wf * sin).abs() + (hf * cos).abs()).round().max(1.0) as u32;
    let (cx_out, cy_out) = (out_w as f32 / 2.0, out_h as f32 / 2.0);
    let (cx_in, cy_in) = (wf / 2.0, hf / 2.0);

    let mut out = image::RgbaImage::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            // Dest pixel center, relative to the canvas center
            let dx = x as f32 + 0.5 - cx_out;
            let dy = y as f32 + 0.5 - cy_out;
            // Inverse rotation (transposed matrix of the clockwise forward map)
            let sx = dx * cos + dy * sin + cx_in - 0.5;
            let sy = -dx * sin + dy * cos + cy_in - 0.5;
            out.put_pixel(x, y, sample_bilinear(&src, sx, sy));
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Projective transform, applied as (x, y, 1) * coeffs (homogeneous divide).
struct Homography {
    a: f32, b: f32, c: f32,
    d: f32, e: f32, f: f32,
    g: f32, k: f32,
}

impl Homography {
    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        let denom = self.g * x + self.k * y + 1.0;
        if !denom.is_finite() || denom.abs() < 1e-9 {
            return (f32::NAN, f32::NAN);
        }
        (
            (self.a * x + self.b * y + self.c) / denom,
            (self.d * x + self.e * y + self.f) / denom,
        )
    }
}

/// Solves the 8x8 linear system `m * x = v` via Gaussian elimination with
/// partial pivoting. Returns zeroed coefficients on a (near-)singular system.
fn solve_linear8(mut m: [[f32; 8]; 8], mut v: [f32; 8]) -> [f32; 8] {
    for col in 0..8 {
        let mut pivot = col;
        for r in (col + 1)..8 {
            if m[r][col].abs() > m[pivot][col].abs() {
                pivot = r;
            }
        }
        m.swap(col, pivot);
        v.swap(col, pivot);

        let d = m[col][col];
        if d.abs() < 1e-9 {
            return [0.0; 8];
        }
        for r in (col + 1)..8 {
            let factor = m[r][col] / d;
            let pivot_row = m[col];
            for (val, pv) in m[r][col..8].iter_mut().zip(pivot_row[col..8].iter()) {
                *val -= factor * pv;
            }
            v[r] -= factor * v[col];
        }
    }

    let mut x = [0.0f32; 8];
    for r in (0..8).rev() {
        let mut acc = v[r];
        for (val, sv) in m[r][(r + 1)..8].iter().zip(x[(r + 1)..8].iter()) {
            acc -= val * sv;
        }
        x[r] = acc / m[r][r];
    }
    x
}

/// Builds the homography mapping the rectangle (0,0)-(dst_w, dst_h) onto the
/// four quad corners (top-left, top-right, bottom-right, bottom-left).
fn homography_from_corners(
    dst_w: u32,
    dst_h: u32,
    quad: [(f32, f32); 4],
) -> Homography {
    // Dest corners in the same order as the quad
    let dst = [
        (0.0, 0.0),
        (dst_w as f32, 0.0),
        (dst_w as f32, dst_h as f32),
        (0.0, dst_h as f32),
    ];

    // System rows for the unknowns [a, b, c, d, e, f, g, k], with the
    // convention X = (a x + b y + c) / (g x + k y + 1), Y = (d x + e y + f) / (g x + k y + 1)
    let mut m = [[0.0f32; 8]; 8];
    let mut v = [0.0f32; 8];
    for i in 0..4 {
        let (x, y) = dst[i];
        let (qx, qy) = quad[i];
        let row = i * 2;
        m[row] = [x, y, 1.0, 0.0, 0.0, 0.0, -qx * x, -qx * y];
        v[row] = qx;
        m[row + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -qy * x, -qy * y];
        v[row + 1] = qy;
    }

    let [a, b, c, d, e, f, g, k] = solve_linear8(m, v);
    Homography { a, b, c, d, e, f, g, k }
}

/// Extracts a symmetric trapezoid (keystone correction) from `img` into a
/// rectangle of the same dimensions. `v` and `h` are keystone amounts in
/// (-1, 1): `v > 0` narrows the top edge, `v < 0` the bottom one; `h > 0`
/// shortens the left edge, `h < 0` the right one. The trapezoid is always
/// inscribed in the source (the widest edges span the full canvas).
/// Inverse-mapped with bilinear sampling.
fn perspective_correct(img: &DynamicImage, v: f32, h: f32) -> DynamicImage {
    let src = img.to_rgba8();
    let (w, h_px) = src.dimensions();
    let v = v.clamp(-0.95, 0.95);
    let h = h.clamp(-0.95, 0.95);
    let (wf, hf) = (w as f32, h_px as f32);

    // Extents of the 4 edges of the trapezoid: the edge matching the
    // keystone direction shrinks, the opposite one spans the full canvas
    let tw = wf * (1.0 - v.max(0.0));  // top edge width
    let bw = wf * (1.0 - (-v).max(0.0)); // bottom edge width
    let lh = hf * (1.0 - h.max(0.0));  // left edge height
    let rh = hf * (1.0 - (-h).max(0.0)); // right edge height

    // Source quadrilateral, symmetric about the canvas center
    let quad = [
        ((wf - tw) / 2.0, (hf - lh) / 2.0), // top-left
        ((wf + tw) / 2.0, (hf - rh) / 2.0), // top-right
        ((wf + bw) / 2.0, (hf + rh) / 2.0), // bottom-right
        ((wf - bw) / 2.0, (hf + lh) / 2.0), // bottom-left
    ];

    let out_w = tw.max(bw).round().max(1.0) as u32;
    let out_h = lh.max(rh).round().max(1.0) as u32;
    let homography = homography_from_corners(out_w, out_h, quad);

    let mut out = image::RgbaImage::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            // The homography maps corner-space to corner-space: feeding the
            // dest pixel center (x+0.5, y+0.5) yields the source sampling
            // point directly.
            let (sx, sy) = homography.apply(x as f32 + 0.5, y as f32 + 0.5);
            out.put_pixel(x, y, sample_bilinear(&src, sx, sy));
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Applies the transform chain to a copy of `img`: fine rotation first
/// (canvas expanded, transparent corners), then keystone extraction.
fn apply_transform(img: &DynamicImage, params: &TransformParams) -> DynamicImage {
    let mut out = img.clone();
    if params.rotation != 0.0 {
        out = rotate_fine(&out, params.rotation);
    }
    if params.perspective_v != 0.0 || params.perspective_h != 0.0 {
        out = perspective_correct(&out, params.perspective_v, params.perspective_h);
    }
    out
}

/// Crops the stored original image in place, in original pixel coordinates.
#[tauri::command]
pub fn crop_image(
    state: State<'_, ImageState>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<LoadedImageInfo, AppError> {
    let mut original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_mut()
        .ok_or_else(|| err("no_image_loaded"))?;

    let (ow, oh) = original.dimensions();
    let x = x.min(ow.saturating_sub(1));
    let y = y.min(oh.saturating_sub(1));
    let width = width.clamp(1, ow - x);
    let height = height.clamp(1, oh - y);

    let cropped = image::imageops::crop_imm(original, x, y, width, height).to_image();
    let img = DynamicImage::ImageRgba8(cropped);
    *original = img.clone();
    drop(original_guard);

    let (w, h) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: w,
        orig_height: h,
    })
}

/// Computes the transformed image for preview purposes, without touching
/// the stored state.
#[tauri::command]
pub fn preview_image_transform(
    state: State<'_, ImageState>,
    params: TransformParams,
) -> Result<tauri::ipc::Response, AppError> {
    let guard = state.original.lock().unwrap();
    let original = guard
        .as_ref()
        .ok_or_else(|| err("no_image_loaded"))?;

    let img = apply_transform(original, &params);
    Ok(rgba_ipc_response(&img))
}

/// Applies the transform chain to the stored original image, in place.
#[tauri::command]
pub fn apply_image_transform(
    state: State<'_, ImageState>,
    params: TransformParams,
) -> Result<LoadedImageInfo, AppError> {
    let mut original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_mut()
        .ok_or_else(|| err("no_image_loaded"))?;

    let img = apply_transform(original, &params);
    *original = img.clone();
    drop(original_guard);

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: width,
        orig_height: height,
    })
}

/// Rotates the loaded original image by 90° clockwise, in place: the
/// stored original becomes the rotated image, so subsequent adjustments
/// (and the grid deduced from its ratio) apply to the rotated version.
#[tauri::command]
pub fn rotate_image(state: State<'_, ImageState>) -> Result<LoadedImageInfo, AppError> {
    let mut original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_mut()
        .ok_or_else(|| err("no_image_loaded"))?;

    *original = original.rotate90();
    let img = original.clone();
    drop(original_guard);

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: width,
        orig_height: height,
    })
}

#[tauri::command]
pub fn apply_image_adjustments(
    state: State<'_, ImageState>,
    params: AdjustmentParams,
) -> Result<tauri::ipc::Response, AppError> {
    let original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_ref()
        .ok_or_else(|| err("no_image_loaded"))?;

    let (orig_w, orig_h) = original.dimensions();

    // --- Actual downsampling: grid_width becomes the number of columns/notes ---
    // The ratio is always deduced from the original image (no independent grid_height).
    let target_w = params.grid_width.max(1);
    let target_h = ((orig_h as f64) * (target_w as f64) / (orig_w as f64))
        .round()
        .max(1.0) as u32;

    let mut img = original.resize_exact(
        target_w,
        target_h,
        image::imageops::FilterType::Nearest,
    );

    // --- Pattern adjustments (applied at grid scale: they act on the very
    // pixels the synthesizers read, note to note) ---
    if params.auto_levels {
        img = auto_levels(&img);
    }

    if params.simplify > 0.0 {
        img = bilateral_simplify(&img, params.simplify);
    }

    if params.clarity != 0.0 {
        let sigma = (target_w.max(target_h) as f32 / 16.0).clamp(2.0, 32.0);
        img = unsharp_mask(&img, sigma, params.clarity);
    }

    if params.texture != 0.0 {
        img = unsharp_mask(&img, 1.5, params.texture);
    }

    // --- Adjustments ---
    if params.vibrance != 0.0 {
        img = adjust_vibrance(&img, params.vibrance);
    }

    if params.contrast != 0.0 {
        img = img.adjust_contrast(params.contrast);
    }

    if params.brightness != 0 {
        img = img.brighten(params.brightness);
    }

    if let Some(levels) = params.posterize_levels {
        if levels >= 2 {
            img = posterize(&img, levels);
        }
    }

    let response = rgba_ipc_response(&img);

    drop(original_guard);
    *state.processed.lock().unwrap() = Some(img);

    Ok(response)
}

/// Adjusts color vibrance. Like saturation, but softer: `factor` is a
/// percentage in [-100, 100]; positive values boost muted colors more than
/// already-saturated ones (which stay natural, without clipping), -100
/// fully desaturates (grayscale), 0 is a no-op.
fn adjust_vibrance(img: &DynamicImage, factor: f32) -> DynamicImage {
    let amount = (factor / 100.0).max(-1.0);

    let mut rgba = img.to_rgba8();
    for pixel in rgba.pixels_mut() {
        let luma = pixel_luma8(pixel) as f32;
        // How saturated the pixel already is: 0 for gray, ~1.33 for a
        // fully saturated primary
        let max = pixel[0].max(pixel[1]).max(pixel[2]) as f32;
        let avg = (pixel[0] as f32 + pixel[1] as f32 + pixel[2] as f32) / 3.0;
        let sat = (max - avg) * 2.0 / 255.0;

        // Positive: the more saturated the pixel, the weaker the boost.
        // Negative: uniform desaturation (same as raw saturation).
        let scale = if amount > 0.0 {
            1.0 + amount * (1.0 - sat.min(1.0))
        } else {
            1.0 + amount
        };

        for channel in 0..3 {
            let v = pixel[channel] as f32;
            let boosted = (luma + (v - luma) * scale).clamp(0.0, 255.0);
            pixel[channel] = boosted as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

fn pixel_luma8(pixel: &image::Rgba<u8>) -> u8 {
    // Rec. 601 luma, same weights as image::Luma conversion
    let r = pixel[0] as u32;
    let g = pixel[1] as u32;
    let b = pixel[2] as u32;
    ((r * 299 + g * 587 + b * 114) / 1000) as u8
}

/// Reduces each RGB channel to `levels` distinct steps (classic posterize).
fn posterize(img: &DynamicImage, levels: u8) -> DynamicImage {
    let levels = levels.max(2) as f32;
    let step = 255.0 / (levels - 1.0);

    let mut rgba = img.to_rgba8();
    for pixel in rgba.pixels_mut() {
        for channel in 0..3 {
            let v = pixel[channel] as f32;
            let posterized = ((v / step).round() * step).clamp(0.0, 255.0);
            pixel[channel] = posterized as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

/// Separable Gaussian blur with standard deviation `sigma` in pixels.
/// RGB channels are blurred; alpha is copied through unchanged.
fn gaussian_blur(img: &DynamicImage, sigma: f32) -> DynamicImage {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 || sigma <= 0.0 {
        return DynamicImage::ImageRgba8(rgba);
    }

    // Half-kernel (it is symmetric): weights normalized so the full kernel sums to 1
    let radius = (sigma * 3.0).ceil() as usize;
    let denom = 2.0 * sigma * sigma;
    let mut kernel = Vec::with_capacity(radius + 1);
    let mut sum = 0.0f32;
    for i in 0..=radius {
        let w = (-(i as f32).powi(2) / denom).exp();
        kernel.push(w);
        sum += if i == 0 { w } else { 2.0 * w };
    }
    for w in kernel.iter_mut() {
        *w /= sum;
    }

    let horizontal = blur_axis(&rgba, width, height, radius, &kernel, true);
    let blurred = blur_axis(&horizontal, width, height, radius, &kernel, false);
    DynamicImage::ImageRgba8(blurred)
}

/// One axis of the separable Gaussian blur, with edge clamping.
fn blur_axis(
    src: &image::RgbaImage,
    width: u32,
    height: u32,
    radius: usize,
    kernel: &[f32],
    horizontal: bool,
) -> image::RgbaImage {
    let (outer, inner) = if horizontal { (height, width) } else { (width, height) };
    let mut out = image::RgbaImage::new(width, height);

    for o in 0..outer {
        for i in 0..inner {
            let mut acc = [0.0f32; 3];
            for j in 0..=(2 * radius) {
                let offset = j as isize - radius as isize;
                let idx = (i as isize + offset)
                    .clamp(0, inner as isize - 1) as u32;
                let (x, y) = if horizontal { (idx, o) } else { (o, idx) };
                let p = src.get_pixel(x, y);
                let w = kernel[offset.unsigned_abs() as usize];
                acc[0] += p[0] as f32 * w;
                acc[1] += p[1] as f32 * w;
                acc[2] += p[2] as f32 * w;
            }
            let (x, y) = if horizontal { (i, o) } else { (o, i) };
            let mut px = *src.get_pixel(x, y);
            for c in 0..3 {
                px[c] = acc[c].round().clamp(0.0, 255.0) as u8;
            }
            out.put_pixel(x, y, px);
        }
    }
    out
}

/// Unsharp mask: boosts (or, for a negative amount, softens) the difference
/// between the image and a blurred copy of itself at the given scale.
/// `sigma` is the blur scale in pixels, `amount` a percentage in [-100, 100].
/// Texture uses a small sigma (fine detail), clarity a large one (local
/// contrast between whole zones).
fn unsharp_mask(img: &DynamicImage, sigma: f32, amount: f32) -> DynamicImage {
    let scale = amount.clamp(-100.0, 100.0) / 100.0;
    let blurred = gaussian_blur(img, sigma);

    let mut rgba = img.to_rgba8();
    let blurred_rgba = blurred.to_rgba8();
    for (pixel, ref_pixel) in rgba.pixels_mut().zip(blurred_rgba.pixels()) {
        for channel in 0..3 {
            let v = pixel[channel] as f32;
            let b = ref_pixel[channel] as f32;
            let sharpened = (v + (v - b) * scale).clamp(0.0, 255.0);
            pixel[channel] = sharpened as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

/// Edge-preserving smoothing (bilateral filter): flattens near-uniform color
/// areas while keeping the boundaries between different colors crisp.
/// `strength` is a percentage in [0, 100]: higher values merge similar shades
/// more aggressively (a second pass runs above 50).
fn bilateral_simplify(img: &DynamicImage, strength: f32) -> DynamicImage {
    let mut current = img.to_rgba8();
    let (width, height) = current.dimensions();
    if width == 0 || height == 0 {
        return DynamicImage::ImageRgba8(current);
    }

    let radius = 2i32;
    let sigma_color = 15.0 + strength.clamp(0.0, 100.0) / 100.0 * 45.0;
    let passes = if strength > 50.0 { 2 } else { 1 };

    // Spatial weights of the 5x5 neighborhood (sigma_space = 2 px)
    let mut spatial = [[0.0f32; 5]; 5];
    for (dy, row) in spatial.iter_mut().enumerate() {
        for (dx, w) in row.iter_mut().enumerate() {
            let d = ((dx as i32 - 2).pow(2) + (dy as i32 - 2).pow(2)) as f32;
            *w = (-d / 8.0).exp();
        }
    }

    // Color weights, looked up by the summed squared per-channel difference,
    // averaged over the three channels to keep the table small
    let two_sigma_sq = 2.0 * sigma_color * sigma_color;
    let color_lut: Vec<f32> = (0..=255 * 255)
        .map(|d| (-(d as f32) / two_sigma_sq).exp())
        .collect();

    for _ in 0..passes {
        let src = current.clone();
        for y in 0..height {
            for x in 0..width {
                let center = src.get_pixel(x, y);
                let (cr, cg, cb) = (center[0] as i32, center[1] as i32, center[2] as i32);
                let mut acc = [0.0f32; 3];
                let mut weight_sum = 0.0f32;
                for dy in -radius..=radius {
                    for dx in -radius..=radius {
                        let nx = (x as i32 + dx).clamp(0, width as i32 - 1) as u32;
                        let ny = (y as i32 + dy).clamp(0, height as i32 - 1) as u32;
                        let p = src.get_pixel(nx, ny);
                        let dr = p[0] as i32 - cr;
                        let dg = p[1] as i32 - cg;
                        let db = p[2] as i32 - cb;
                        let dist = (dr * dr + dg * dg + db * db) / 3;
                        let w = spatial[(dy + radius) as usize][(dx + radius) as usize]
                            * color_lut[dist.clamp(0, 255 * 255) as usize];
                        acc[0] += p[0] as f32 * w;
                        acc[1] += p[1] as f32 * w;
                        acc[2] += p[2] as f32 * w;
                        weight_sum += w;
                    }
                }
                let mut px = *center;
                for c in 0..3 {
                    px[c] = (acc[c] / weight_sum).round().clamp(0.0, 255.0) as u8;
                }
                current.put_pixel(x, y, px);
            }
        }
    }
    DynamicImage::ImageRgba8(current)
}

/// Stretches the luma histogram to the full [0, 255] range (auto levels).
/// The black and white points sit at the 0.5% percentiles so stray pixels
/// don't fool the stretch. Only the luma is remapped: each channel keeps
/// its offset from it, so the chroma — hence the hue, and the pitch
/// mapping — stays stable.
fn auto_levels(img: &DynamicImage) -> DynamicImage {
    let mut rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let pixel_count = (width * height) as usize;
    if pixel_count == 0 {
        return DynamicImage::ImageRgba8(rgba);
    }

    let mut histogram = [0u32; 256];
    for pixel in rgba.pixels() {
        histogram[pixel_luma8(pixel) as usize] += 1;
    }

    // Black and white points where 0.5% of the pixels have been seen
    // from each end of the histogram
    let clip = (pixel_count as f32 * 0.005).ceil() as u32;
    let mut black = 0u32;
    let mut acc = 0u32;
    for (level, count) in histogram.iter().enumerate() {
        acc += count;
        black = level as u32;
        if acc > clip {
            break;
        }
    }
    let mut white = 255u32;
    let mut acc = 0u32;
    for (level, count) in histogram.iter().enumerate().rev() {
        acc += count;
        white = level as u32;
        if acc > clip {
            break;
        }
    }

    // Already using (nearly) the full range: no-op
    if white <= black + 16 {
        return DynamicImage::ImageRgba8(rgba);
    }

    let scale = 255.0 / (white - black) as f32;
    for pixel in rgba.pixels_mut() {
        let luma = pixel_luma8(pixel) as f32;
        let stretched = (luma - black as f32) * scale;
        for channel in 0..3 {
            let v = pixel[channel] as f32;
            let adjusted = (stretched + v - luma).clamp(0.0, 255.0);
            pixel[channel] = adjusted as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homography_maps_the_dest_corners_onto_the_quad() {
        let quad = [(10.0, 20.0), (110.0, 15.0), (105.0, 215.0), (5.0, 210.0)];
        let h = homography_from_corners(100, 200, quad);
        let eps = 1e-3;

        let tl = h.apply(0.0, 0.0);
        let tr = h.apply(100.0, 0.0);
        let br = h.apply(100.0, 200.0);
        let bl = h.apply(0.0, 200.0);

        assert!((tl.0 - quad[0].0).abs() < eps && (tl.1 - quad[0].1).abs() < eps);
        assert!((tr.0 - quad[1].0).abs() < eps && (tr.1 - quad[1].1).abs() < eps);
        assert!((br.0 - quad[2].0).abs() < eps && (br.1 - quad[2].1).abs() < eps);
        assert!((bl.0 - quad[3].0).abs() < eps && (bl.1 - quad[3].1).abs() < eps);
    }

    #[test]
    fn perspective_keeps_the_wider_edge_intact() {
        // 100x100 solid image, vertical keystone: bottom wider than top
        let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(100, 100, image::Rgba([200, 150, 100, 255])));
        let out = perspective_correct(&img, 0.2, 0.0);
        assert_eq!(out.dimensions(), (100, 100));

        // The bottom edge of the trapezoid (full width) must be kept: the
        // bottom row of the output samples the bottom row of the source
        let rgba = out.to_rgba8();
        assert_eq!(rgba.get_pixel(0, 99), &image::Rgba([200, 150, 100, 255]));
        assert_eq!(rgba.get_pixel(99, 99), &image::Rgba([200, 150, 100, 255]));
        // The top row samples the (narrower) top edge, still inside the source
        assert_eq!(rgba.get_pixel(50, 0), &image::Rgba([200, 150, 100, 255]));
    }

    #[test]
    fn rotate_fine_expands_the_canvas_and_keeps_center_pixel() {
        // 90° rotation of a 100x50 image swaps the dimensions
        let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(100, 50, image::Rgba([120, 130, 140, 255])));
        let out = rotate_fine(&img, 90.0);
        assert_eq!(out.dimensions(), (50, 100));
        assert_eq!(out.to_rgba8().get_pixel(25, 50), &image::Rgba([120, 130, 140, 255]));

        // A small angle only slightly expands the canvas
        let out = rotate_fine(&img, 10.0);
        let (w, h) = out.dimensions();
        assert!(w >= 100 && w < 130, "unexpected width {w}");
        assert!(h >= 50 && h < 130, "unexpected height {h}");
    }

    #[test]
    fn sample_bilinear_interpolates_and_fills_outside() {
        let mut src = image::RgbaImage::new(2, 2);
        src.put_pixel(0, 0, image::Rgba([0, 0, 0, 255]));
        src.put_pixel(1, 0, image::Rgba([100, 100, 100, 255]));
        src.put_pixel(0, 1, image::Rgba([200, 200, 200, 255]));
        src.put_pixel(1, 1, image::Rgba([255, 255, 255, 255]));

        let mid = sample_bilinear(&src, 0.5, 0.5);
        assert!((mid[0] as i32 - 139).abs() <= 1);

        let outside = sample_bilinear(&src, 5.0, 5.0);
        assert_eq!(outside, image::Rgba([0, 0, 0, 0]));
    }

    #[test]
    fn unsharp_mask_is_identity_on_uniform_image() {
        let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8, 8, image::Rgba([120, 60, 200, 255]),
        ));
        let out = unsharp_mask(&img, 1.5, 100.0);
        assert!(out
            .to_rgba8()
            .pixels()
            .all(|p| p == &image::Rgba([120, 60, 200, 255])));
    }

    #[test]
    fn unsharp_mask_stretches_the_step_edge() {
        // 8x1: four dark pixels, four bright pixels
        let mut buf = image::RgbaImage::new(8, 1);
        for x in 0..8 {
            let v = if x < 4 { 64 } else { 192 };
            buf.put_pixel(x, 0, image::Rgba([v, v, v, 255]));
        }
        let out = unsharp_mask(&DynamicImage::ImageRgba8(buf), 1.5, 100.0).to_rgba8();
        assert!(out.get_pixel(3, 0)[0] < 64, "dark edge side should get darker");
        assert!(out.get_pixel(4, 0)[0] > 192, "bright edge side should get brighter");
    }

    #[test]
    fn unsharp_mask_with_negative_amount_blurs() {
        let mut buf = image::RgbaImage::new(8, 1);
        for x in 0..8 {
            let v = if x < 4 { 64 } else { 192 };
            buf.put_pixel(x, 0, image::Rgba([v, v, v, 255]));
        }
        let out = unsharp_mask(&DynamicImage::ImageRgba8(buf), 1.5, -100.0).to_rgba8();
        // At -100 the output is the blurred copy: the edge is softened
        assert!(out.get_pixel(3, 0)[0] > 64 && out.get_pixel(4, 0)[0] < 192);
    }

    #[test]
    fn bilateral_simplify_flattens_outliers_but_keeps_flat_areas() {
        // 9x9 all at 100, one outlier at 160 in the center
        let mut buf = image::RgbaImage::from_pixel(9, 9, image::Rgba([100, 100, 100, 255]));
        buf.put_pixel(4, 4, image::Rgba([160, 160, 160, 255]));
        let out = bilateral_simplify(&DynamicImage::ImageRgba8(buf), 50.0).to_rgba8();

        let center = out.get_pixel(4, 4)[0];
        assert!(center > 100 && center < 160, "outlier should be pulled toward the flat area");
        assert_eq!(out.get_pixel(0, 0)[0], 100, "flat area must stay unchanged");
    }

    #[test]
    fn vibrance_boosts_muted_colors_more_than_saturated_ones() {
        let mut buf = image::RgbaImage::new(2, 1);
        buf.put_pixel(0, 0, image::Rgba([200, 180, 160, 255])); // muted pastel
        buf.put_pixel(1, 0, image::Rgba([255, 0, 0, 255])); // fully saturated primary
        let out = adjust_vibrance(&DynamicImage::ImageRgba8(buf), 50.0).to_rgba8();

        // The pastel gets a visible chroma boost...
        assert!(out.get_pixel(0, 0)[0] > 200, "muted red channel should increase");
        assert!(out.get_pixel(0, 0)[2] < 160, "muted blue channel should decrease");
        // ...while the saturated primary is left untouched
        assert_eq!(out.get_pixel(1, 0), &image::Rgba([255, 0, 0, 255]));
    }

    #[test]
    fn vibrance_negative_fully_desaturates() {
        let mut buf = image::RgbaImage::new(1, 1);
        buf.put_pixel(0, 0, image::Rgba([200, 100, 50, 255]));
        let out = adjust_vibrance(&DynamicImage::ImageRgba8(buf), -100.0).to_rgba8();

        let p = out.get_pixel(0, 0);
        assert_eq!(p[0], p[1], "grayscale: all channels must be equal");
        assert_eq!(p[1], p[2], "grayscale: all channels must be equal");
        assert_eq!(p[0], pixel_luma8(&image::Rgba([200, 100, 50, 255])));
    }

    #[test]
    fn auto_levels_stretches_a_narrow_range() {
        // 32x32 grayscale gradient, luma 100..150
        let mut buf = image::RgbaImage::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                let v = (100.0 + x as f32 * 50.0 / 31.0) as u8;
                buf.put_pixel(x, y, image::Rgba([v, v, v, 255]));
            }
        }
        let out = auto_levels(&DynamicImage::ImageRgba8(buf)).to_rgba8();

        assert!(out.get_pixel(0, 0)[0] <= 5, "dark end should reach black");
        assert_eq!(out.get_pixel(31, 0)[0], 255, "bright end should reach white");
    }

    #[test]
    fn auto_levels_preserves_channel_ordering() {
        // Two uniform halves: warm dark on the left, warm bright on the right
        let mut buf = image::RgbaImage::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                let px = if x < 16 {
                    image::Rgba([100, 80, 60, 255])
                } else {
                    image::Rgba([150, 130, 110, 255])
                };
                buf.put_pixel(x, y, px);
            }
        }
        let out = auto_levels(&DynamicImage::ImageRgba8(buf)).to_rgba8();

        let left = out.get_pixel(0, 0);
        let right = out.get_pixel(31, 0);
        assert!(left[0] > left[1] && left[1] >= left[2], "hue must survive the stretch (dark)");
        assert!(right[0] > right[1] && right[1] > right[2], "hue must survive the stretch (bright)");
        assert_eq!(right[0], 255, "bright half should reach white");
    }

    #[test]
    fn auto_levels_is_a_noop_on_full_range_image() {
        // Alternating black and white columns: nothing to stretch
        let mut buf = image::RgbaImage::new(32, 32);
        for y in 0..32 {
            for x in 0..32 {
                let v = if x % 2 == 0 { 0 } else { 255 };
                buf.put_pixel(x, y, image::Rgba([v, v, v, 255]));
            }
        }
        let src = buf.clone();
        let out = auto_levels(&DynamicImage::ImageRgba8(buf)).to_rgba8();
        for y in 0..32 {
            for x in 0..32 {
                assert_eq!(out.get_pixel(x, y), src.get_pixel(x, y), "must stay untouched");
            }
        }
    }
}

