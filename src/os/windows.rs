#![deny(clippy::all)]

use crate::{Lock, LockAttempt};

use std::mem::MaybeUninit;
use winapi::shared::minwindef::{DWORD, HMODULE, TRUE};
use winapi::shared::winerror::{ERROR_IO_PENDING, ERROR_LOCK_VIOLATION};
use winapi::um::fileapi::{LockFileEx, UnlockFileEx};
use winapi::um::handleapi::CloseHandle;
use winapi::um::ioapiset::GetOverlappedResult;
use winapi::um::libloaderapi::{GetModuleHandleA, GetProcAddress};
use winapi::um::minwinbase::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OVERLAPPED};
use winapi::um::synchapi::CreateEventW;
use winapi::um::winnt::HANDLE;

pub type FileDescriptor = i32;
pub type Offset = u64;
pub type Length = u64;

/// Acquire, release, or test a file lock using `LockFileEx`/`UnlockFileEx`.
///
/// When `range` is `None` the entire file is locked (`0..u64::MAX`).
/// For blocking requests on overlapped handles, an event is attached so
/// `GetOverlappedResult` can wait for `ERROR_IO_PENDING`.
pub fn file_lock(
    fd: FileDescriptor,
    lock: Lock,
    range: Option<(Offset, Length)>,
    blocking: bool,
) -> std::io::Result<LockAttempt> {
    let (offset, len) = range.unwrap_or((0, u64::MAX));

    let handle = get_windows_handle(fd)?;

    let mut ov: OVERLAPPED = unsafe { MaybeUninit::zeroed().assume_init() };
    unsafe {
        let s = ov.u.s_mut();
        s.Offset = (offset & 0xffff_ffff) as DWORD;
        s.OffsetHigh = (offset >> 32) as DWORD;
    }

    let len_low = (len & 0xffff_ffff) as DWORD;
    let len_high = (len >> 32) as DWORD;

    // For blocking lock attempts on overlapped handles, attach an event so we can
    // wait via GetOverlappedResult if LockFileEx returns ERROR_IO_PENDING.
    let _event = if blocking && !matches!(lock, Lock::Unlock) {
        let event = create_event()?;
        ov.hEvent = event.0;
        Some(event)
    } else {
        None
    };

    let rc = unsafe {
        match lock {
            Lock::Exclusive => {
                let mut flags = LOCKFILE_EXCLUSIVE_LOCK;
                if !blocking {
                    flags |= LOCKFILE_FAIL_IMMEDIATELY;
                }
                LockFileEx(handle, flags, 0, len_low, len_high, &mut ov)
            }
            Lock::Shared => {
                let mut flags = 0;
                if !blocking {
                    flags |= LOCKFILE_FAIL_IMMEDIATELY;
                }
                LockFileEx(handle, flags, 0, len_low, len_high, &mut ov)
            }
            Lock::Unlock => UnlockFileEx(handle, 0, len_low, len_high, &mut ov),
        }
    };

    if rc != 0 {
        return Ok(LockAttempt::Acquired);
    }

    let err = std::io::Error::last_os_error();
    match err.raw_os_error().map(|c| c as u32) {
        Some(ERROR_LOCK_VIOLATION) if !blocking && !matches!(lock, Lock::Unlock) => {
            Ok(LockAttempt::WouldBlock)
        }

        // Blocking path on an overlapped handle: wait for the pending lock to complete.
        Some(ERROR_IO_PENDING) if blocking && !matches!(lock, Lock::Unlock) => {
            let mut transferred: DWORD = 0;
            let ok = unsafe { GetOverlappedResult(handle, &mut ov, &mut transferred, TRUE) };
            if ok != 0 {
                Ok(LockAttempt::Acquired)
            } else {
                Err(std::io::Error::last_os_error())
            }
        }

        _ => Err(err),
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Create a manual-reset event for overlapped I/O waits.
fn create_event() -> std::io::Result<OwnedHandle> {
    let event = unsafe { CreateEventW(std::ptr::null_mut(), TRUE, 0, std::ptr::null()) };
    if event.is_null() {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(OwnedHandle(event))
    }
}

/// Convert a C file descriptor to a Windows `HANDLE` via libuv's `uv_get_osfhandle`.
fn get_windows_handle(fd: i32) -> std::io::Result<HANDLE> {
    let uv_get_osfhandle = resolve_uv_get_osfhandle()?;
    let handle = unsafe { uv_get_osfhandle(fd) };

    if handle.is_null() || handle == (-1isize as HANDLE) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid OS handle for fd {}", fd),
        ));
    }

    Ok(handle)
}

type UvGetOsfHandle = unsafe extern "C" fn(i32) -> HANDLE;

/// Resolve `uv_get_osfhandle` from the host Node.js process. Tries
/// `libnode.dll`, `node.dll`, and the implicit module in that order.
fn resolve_uv_get_osfhandle() -> std::io::Result<UvGetOsfHandle> {
    static FN: std::sync::OnceLock<Option<UvGetOsfHandle>> = std::sync::OnceLock::new();

    let f = FN.get_or_init(|| unsafe {
        let name = c"uv_get_osfhandle";

        let candidates: [HMODULE; 3] = [
            GetModuleHandleA(c"libnode.dll".as_ptr() as _),
            GetModuleHandleA(c"node.dll".as_ptr() as _),
            GetModuleHandleA(std::ptr::null()),
        ];

        for module in candidates {
            if module.is_null() {
                continue;
            }

            let ptr = GetProcAddress(module, name.as_ptr() as _);
            if !ptr.is_null() {
                let f: UvGetOsfHandle = std::mem::transmute(ptr);
                return Some(f);
            }
        }

        None
    });

    f.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not resolve uv_get_osfhandle from host process",
        )
    })
}
