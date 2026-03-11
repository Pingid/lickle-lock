#![deny(clippy::all)]

use crate::LockAttempt;
use windows_sys::Win32::Foundation::{GetLastError, SetLastError, NO_ERROR};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileType, LockFileEx, UnlockFileEx, FILE_TYPE_DISK, FILE_TYPE_UNKNOWN,
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use windows_sys::Win32::System::IO::OVERLAPPED;

pub type FileDescriptor = i64;

pub fn try_lock_exclusive(fd: FileDescriptor) -> std::io::Result<LockAttempt> {
    // LOCKFILE_FAIL_IMMEDIATELY is required so polling can detect contention.
    attempt_lock(fd, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)
}

pub fn try_lock_shared(fd: FileDescriptor) -> std::io::Result<LockAttempt> {
    attempt_lock(fd, LOCKFILE_FAIL_IMMEDIATELY)
}

pub fn unlock(fd: FileDescriptor) -> std::io::Result<()> {
    let handle = get_handle(fd)?;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };

    let success = unsafe {
        UnlockFileEx(
            handle as _,
            0,
            0xFFFFFFFF, // Unlock the maximum possible length (entire file)
            0xFFFFFFFF,
            &mut overlapped,
        )
    };

    if success != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn attempt_lock(fd: FileDescriptor, flags: u32) -> std::io::Result<LockAttempt> {
    let handle = get_handle(fd)?;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };

    let success = unsafe {
        LockFileEx(
            handle as _,
            flags,
            0,
            0xFFFFFFFF, // Lock the maximum possible length (entire file)
            0xFFFFFFFF,
            &mut overlapped,
        )
    };

    if success != 0 {
        return Ok(LockAttempt::Acquired);
    }

    let err = std::io::Error::last_os_error();
    let code = err.raw_os_error().unwrap_or(0);

    // 33: ERROR_LOCK_VIOLATION
    // 32: ERROR_SHARING_VIOLATION
    if code == 33 || code == 32 {
        return Ok(LockAttempt::WouldBlock);
    }

    Err(err)
}

fn get_handle(fd: FileDescriptor) -> std::io::Result<isize> {
    // Convert Node/libuv file descriptor to OS HANDLE via uv_get_osfhandle.
    let fd_i32 = i32::try_from(fd).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Invalid file descriptor value for Windows backend: {}", fd),
        )
    })?;

    if let Some(handle) = uv_get_osfhandle(fd_i32) {
        if handle != -1 && handle != 0 && is_lockable_file_handle(handle) {
            return Ok(handle);
        }
    }

    // Fallback: some runtimes may expose raw HANDLE-like numeric values.
    let raw = fd as isize;
    if raw != 0 && raw != -1 && is_lockable_file_handle(raw) {
        return Ok(raw);
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        format!("Invalid file descriptor or handle: {}", fd),
    ))
}

type UvGetOsfHandleFn = unsafe extern "C" fn(i32) -> isize;

fn uv_get_osfhandle(fd: i32) -> Option<isize> {
    unsafe {
        let node = GetModuleHandleA(b"node.exe\0".as_ptr());
        if !node.is_null() {
            let sym = GetProcAddress(node, b"uv_get_osfhandle\0".as_ptr());
            if let Some(sym) = sym {
                let func: UvGetOsfHandleFn = std::mem::transmute(sym);
                return Some(func(fd));
            }
        }
    }
    None
}

fn is_valid_file_handle(handle: isize) -> bool {
    unsafe {
        SetLastError(NO_ERROR);
        let file_type = GetFileType(handle as _);
        if file_type == FILE_TYPE_UNKNOWN {
            return GetLastError() == NO_ERROR;
        }
        true
    }
}

fn is_lockable_file_handle(handle: isize) -> bool {
    if !is_valid_file_handle(handle) {
        return false;
    }
    unsafe { GetFileType(handle as _) == FILE_TYPE_DISK }
}
