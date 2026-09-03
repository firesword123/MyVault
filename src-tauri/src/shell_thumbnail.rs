//! Windows Shell thumbnail bridge for the gallery WebView.
//!
//! The OS owns extraction and its cross-application cache. MyVault only copies
//! the returned HBITMAP into an ephemeral BMP response and releases the handle.
use std::{
    path::Path,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
};
use tauri::{http, AppHandle, Manager, UriSchemeContext, UriSchemeResponder, Wry};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{DeleteObject, GetBitmapBits, GetObjectW, BITMAP, HBITMAP, HGDIOBJ},
        System::Com::{CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
            SIIGBF_THUMBNAILONLY,
        },
    },
};

const THUMBNAIL_EDGE: i32 = 256;
const WORKERS: usize = 2;
const QUEUE_CAPACITY: usize = 96;

struct Job {
    app: AppHandle,
    thumbnail_id: String,
    responder: UriSchemeResponder,
}

struct OwnedBitmap(HBITMAP);

impl Drop for OwnedBitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ::from(self.0));
        }
    }
}

fn error_response(status: http::StatusCode, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .expect("static thumbnail error response is valid")
}

fn bmp_response(body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, "image/bmp")
        .header(http::header::CACHE_CONTROL, "no-store")
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("static thumbnail response is valid")
}

fn write_u16(buffer: &mut [u8], offset: usize, value: u16) {
    buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn bitmap_to_bmp(bitmap: HBITMAP) -> Result<Vec<u8>, String> {
    let bitmap = OwnedBitmap(bitmap);
    let mut info = BITMAP::default();
    let copied = unsafe {
        GetObjectW(
            HGDIOBJ::from(bitmap.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut info as *mut BITMAP).cast()),
        )
    };
    if copied != std::mem::size_of::<BITMAP>() as i32
        || info.bmWidth <= 0
        || info.bmHeight == 0
        || info.bmBitsPixel != 32
        || info.bmPlanes != 1
    {
        return Err("Shell returned an unsupported thumbnail bitmap".into());
    }
    let height = info.bmHeight.unsigned_abs();
    let stride = info.bmWidthBytes.unsigned_abs();
    let pixel_bytes = stride
        .checked_mul(height)
        .ok_or_else(|| "Shell thumbnail is too large".to_string())?;
    let file_bytes = 54_u32
        .checked_add(pixel_bytes)
        .ok_or_else(|| "Shell thumbnail is too large".to_string())?;
    let mut body = vec![0_u8; file_bytes as usize];
    body[0..2].copy_from_slice(b"BM");
    write_u32(&mut body, 2, file_bytes);
    write_u32(&mut body, 10, 54);
    write_u32(&mut body, 14, 40);
    write_u32(&mut body, 18, info.bmWidth as u32);
    write_u32(&mut body, 22, info.bmHeight as u32);
    write_u16(&mut body, 26, 1);
    write_u16(&mut body, 28, 32);
    write_u32(&mut body, 34, pixel_bytes);
    let copied =
        unsafe { GetBitmapBits(bitmap.0, pixel_bytes as i32, body[54..].as_mut_ptr().cast()) };
    if copied != pixel_bytes as i32 {
        return Err("failed to copy the Shell thumbnail bitmap".into());
    }
    Ok(body)
}

fn load_shell_thumbnail(path: &Path) -> Result<Vec<u8>, String> {
    let path = path.to_string_lossy().replace('/', "\\");
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|value| format!(r"\\{value}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or(path);
    let value: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let item: IShellItem =
        unsafe { SHCreateItemFromParsingName(PCWSTR(value.as_ptr()), None::<&IBindCtx>) }
            .map_err(|error| format!("Shell item creation failed: {error}"))?;
    let factory: IShellItemImageFactory = item
        .cast()
        .map_err(|error| format!("Shell thumbnail interface lookup failed: {error}"))?;
    let bitmap = unsafe {
        factory.GetImage(
            SIZE {
                cx: THUMBNAIL_EDGE,
                cy: THUMBNAIL_EDGE,
            },
            SIIGBF_RESIZETOFIT | SIIGBF_THUMBNAILONLY,
        )
    }
    .map_err(|error| format!("Shell thumbnail extraction failed: {error}"))?;
    bitmap_to_bmp(bitmap)
}

fn process_job(job: Job) {
    // Resolve again at execution time. A page change replaces the visible ID
    // set, so queued work from a stale page exits without touching the file.
    let state = job.app.state::<crate::gallery::GalleryState>();
    let response = match crate::gallery::visible_thumbnail_path(&state, &job.thumbnail_id) {
        Ok(Some(path)) => match load_shell_thumbnail(&path) {
            Ok(body) => bmp_response(body),
            Err(error) => error_response(http::StatusCode::UNSUPPORTED_MEDIA_TYPE, &error),
        },
        Ok(None) => error_response(
            http::StatusCode::GONE,
            "thumbnail request is no longer visible",
        ),
        Err(error) => error_response(http::StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    job.responder.respond(response);
}

fn worker(receiver: Arc<Mutex<mpsc::Receiver<Job>>>) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    loop {
        let job = receiver
            .lock()
            .ok()
            .and_then(|receiver| receiver.recv().ok());
        let Some(job) = job else { break };
        process_job(job);
    }
    if initialized {
        unsafe { CoUninitialize() };
    }
}

fn sender() -> &'static mpsc::SyncSender<Job> {
    static SENDER: OnceLock<mpsc::SyncSender<Job>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..WORKERS {
            let receiver = receiver.clone();
            thread::Builder::new()
                .name(format!("shell-thumbnail-{index}"))
                .spawn(move || worker(receiver))
                .expect("failed to start Shell thumbnail worker");
        }
        sender
    })
}

pub(crate) fn handle_protocol(
    context: UriSchemeContext<'_, Wry>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if !matches!(context.webview_label(), "gallery" | "embedded-gallery")
        || request.method() != http::Method::GET
    {
        responder.respond(error_response(
            http::StatusCode::FORBIDDEN,
            "thumbnail access denied",
        ));
        return;
    }
    let thumbnail_id = request.uri().path().trim_matches('/');
    if thumbnail_id.len() != 16 || !thumbnail_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        responder.respond(error_response(
            http::StatusCode::BAD_REQUEST,
            "invalid thumbnail ID",
        ));
        return;
    }
    let job = Job {
        app: context.app_handle().clone(),
        thumbnail_id: thumbnail_id.to_ascii_lowercase(),
        responder,
    };
    if let Err(error) = sender().try_send(job) {
        let job = match error {
            mpsc::TrySendError::Full(job) | mpsc::TrySendError::Disconnected(job) => job,
        };
        job.responder.respond(error_response(
            http::StatusCode::SERVICE_UNAVAILABLE,
            "thumbnail queue is full",
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reads_a_thumbnail_through_the_windows_shell() {
        let icon = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/128x128.png");
        let body = thread::spawn(move || {
            let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            initialized
                .ok()
                .expect("fresh Shell thumbnail thread should initialize COM");
            let result = load_shell_thumbnail(&icon);
            let _ = initialized;
            unsafe { CoUninitialize() };
            result
        })
        .join()
        .unwrap()
        .expect("Windows Shell should thumbnail PNG files");
        assert_eq!(&body[..2], b"BM");
        assert!(body.len() > 54);
    }
}
