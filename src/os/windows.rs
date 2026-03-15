#![deny(clippy::all)]

use crate::{Lock, LockAttempt};

use std::mem::MaybeUninit;
use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::{ERROR_IO_PENDING, ERROR_LOCK_VIOLATION};
use winapi::um::fileapi::{LockFileEx, UnlockFileEx};
use winapi::um::minwinbase::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OVERLAPPED};
use winapi::um::winnt::HANDLE;

pub type FileDescriptor = i32;
pub type Offset = u64;
pub type Length = u64;

// pub fn file_lock(
//     fd: FileDescriptor,
//     lock: Lock,
//     range: Option<(Offset, Length)>,
//     _blocking: bool,
// ) -> io::Result<LockAttempt> {
//     eprintln!("get handle");
//     let handle = get_windows_handle(fd)?;

//     // Emulate "whole file" with a giant byte-range lock.
//     let (offset, len) = range.unwrap_or((0, u64::MAX));

//     eprintln!("overlapped_for_offset({})", offset);
//     let mut ov = overlapped_for_offset(offset);
//     let (len_low, len_high) = split_u64(len);

//     let rc = unsafe {
//         match lock {
//             Lock::Unlock => UnlockFileEx(handle, 0, len_low, len_high, &mut ov),

//             // Your outer Rust code already polls, so always use FAIL_IMMEDIATELY here.
//             Lock::Exclusive => LockFileEx(
//                 handle,
//                 LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
//                 0,
//                 len_low,
//                 len_high,
//                 &mut ov,
//             ),

//             Lock::Shared => LockFileEx(
//                 handle,
//                 LOCKFILE_FAIL_IMMEDIATELY,
//                 0,
//                 len_low,
//                 len_high,
//                 &mut ov,
//             ),
//         }
//     };

//     eprintln!("rc: {}", rc);
//     if rc != 0 {
//         return Ok(LockAttempt::Acquired);
//     }

//     let err = io::Error::last_os_error();
//     eprintln!("err: {:?}", err);
//     match (lock, err.raw_os_error()) {
//         // Contended lock attempt.
//         (_, Some(code)) if code == ERROR_LOCK_VIOLATION as i32 && !matches!(lock, Lock::Unlock) => {
//             Ok(LockAttempt::WouldBlock)
//         }
//         _ => Err(err),
//     }
// }

pub fn file_lock(
    fd: FileDescriptor,
    lock: Lock,
    range: Option<(Offset, Length)>,
    _blocking: bool,
) -> std::io::Result<LockAttempt> {
    eprintln!("file_lock");
    // If no range is specified, lock the entire file (0 to u64::MAX)
    let (offset, len) = range.unwrap_or((0, u64::MAX));

    // 1. Get the HANDLE dynamically
    let handle = get_windows_handle(fd as i32)?;

    // 2. Setup the OVERLAPPED structure
    let mut ov: OVERLAPPED = unsafe { MaybeUninit::zeroed().assume_init() };
    unsafe {
        let s = ov.u.s_mut();
        s.Offset = (offset & 0xffffffff) as DWORD;
        s.OffsetHigh = (offset >> 32) as DWORD;
    }

    let lenlow = (len & 0xffffffff) as DWORD;
    let lenhigh = (len >> 32) as DWORD;

    // 3. Execute Lock or Unlock
    let rc = unsafe {
        match lock {
            Lock::Exclusive | Lock::Shared => {
                let mut flags = LOCKFILE_FAIL_IMMEDIATELY;
                if matches!(lock, Lock::Exclusive) {
                    flags |= LOCKFILE_EXCLUSIVE_LOCK;
                }
                LockFileEx(handle, flags, 0, lenlow, lenhigh, &mut ov)
            }
            Lock::Unlock => UnlockFileEx(handle, 0, lenlow, lenhigh, &mut ov),
        }
    };

    // 4. Handle results
    if rc == 0 {
        let err = std::io::Error::last_os_error();
        if let Some(code) = err.raw_os_error() {
            let code = code as u32;
            if code == ERROR_LOCK_VIOLATION || code == ERROR_IO_PENDING {
                return Ok(LockAttempt::WouldBlock);
            }
        }
        return Err(err);
    }

    Ok(LockAttempt::Acquired)
}

fn get_windows_handle(fd: i32) -> std::io::Result<HANDLE> {
    use winapi::um::libloaderapi::{GetModuleHandleA, GetProcAddress};
    eprintln!("get_windows_handle");
    unsafe {
        let func_name = b"uv_get_osfhandle\0";
        let mut func_ptr = std::ptr::null_mut();

        eprintln!("1. Try the main executable (Standard Node.js)");
        // 1. Try the main executable (Standard Node.js)
        let mut module = GetModuleHandleA(std::ptr::null());
        if !module.is_null() {
            func_ptr = GetProcAddress(module, func_name.as_ptr() as *const _);
        }

        eprintln!("2. Try Electron's node library");
        // 2. Try Electron's node library
        if func_ptr.is_null() {
            module = GetModuleHandleA(b"node.dll\0".as_ptr() as *const _);
            if !module.is_null() {
                func_ptr = GetProcAddress(module, func_name.as_ptr() as *const _);
            }
        }

        eprintln!("3. Try alternative shared library naming just in case");
        // 3. Try alternative shared library naming just in case
        if func_ptr.is_null() {
            module = GetModuleHandleA(b"libnode.dll\0".as_ptr() as *const _);
            if !module.is_null() {
                func_ptr = GetProcAddress(module, func_name.as_ptr() as *const _);
            }
        }

        eprintln!("4. Call the libuv function if we found it");
        // 4. Call the libuv function if we found it
        if !func_ptr.is_null() {
            type UvGetOsfHandle = unsafe extern "C" fn(i32) -> HANDLE;
            let uv_get_osfhandle: UvGetOsfHandle = std::mem::transmute(func_ptr);
            let handle = uv_get_osfhandle(fd);

            if handle.is_null() || handle == (-1isize as HANDLE) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "libuv returned an invalid OS handle for the provided fd",
                ));
            }
            return Ok(handle);
        }

        eprintln!("Could not dynamically locate uv_get_osfhandle in the host process");
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Could not dynamically locate uv_get_osfhandle in the host process",
        ))
    }
}
