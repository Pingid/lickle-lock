#![deny(clippy::all)]

use std::mem::MaybeUninit;

use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::{ERROR_IO_PENDING, ERROR_LOCK_VIOLATION};
use winapi::um::fileapi::{LockFileEx, UnlockFileEx};
use winapi::um::minwinbase::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OVERLAPPED};
use winapi::um::winnt::HANDLE;

use crate::{Lock, LockAttempt};

pub type FileDescriptor = i32;
pub type Offset = u64;
pub type Length = u64;

extern "C" {
    // MSVCRT function to convert a POSIX-style fd to a Windows HANDLE
    fn _get_osfhandle(fd: i32) -> isize;
}

pub fn file_lock(
    fd: FileDescriptor,
    lock: Lock,
    range: Option<(Offset, Length)>,
) -> std::io::Result<LockAttempt> {
    // If no range is specified, lock the entire file (0 to u64::MAX)
    let (offset, len) = range.unwrap_or((0, u64::MAX));

    // 1. Convert the Node.js integer fd to a Windows HANDLE
    let handle = unsafe { _get_osfhandle(fd) };
    if handle == -1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid file descriptor: could not get OS handle",
        ));
    }
    let handle = handle as HANDLE;

    // 2. Setup the OVERLAPPED structure for the range offset
    let mut ov: OVERLAPPED = unsafe { MaybeUninit::zeroed().assume_init() };
    unsafe {
        let s = ov.u.s_mut();
        s.Offset = (offset & 0xffffffff) as DWORD;
        s.OffsetHigh = (offset >> 32) as DWORD; // Replaced `>> 16 >> 16` with `>> 32` for clarity
    }

    let lenlow = (len & 0xffffffff) as DWORD;
    let lenhigh = (len >> 32) as DWORD;

    // 3. Execute Lock or Unlock
    let rc = unsafe {
        match lock {
            Lock::Exclusive | Lock::Shared => {
                // Since your `lib.rs` handles polling/blocking asynchronously using `spawn_blocking`,
                // we tell the OS to fail immediately rather than blocking the native thread.
                let mut flags = LOCKFILE_FAIL_IMMEDIATELY;
                if matches!(lock, Lock::Exclusive) {
                    flags |= LOCKFILE_EXCLUSIVE_LOCK;
                }
                LockFileEx(handle, flags, 0, lenlow, lenhigh, &mut ov)
            }
            Lock::Unlock => UnlockFileEx(handle, 0, lenlow, lenhigh, &mut ov),
        }
    };

    // 4. Handle results and map errors
    if rc == 0 {
        let err = std::io::Error::last_os_error();
        if let Some(code) = err.raw_os_error() {
            let code = code as u32;
            // ERROR_LOCK_VIOLATION: Locked by another process.
            // ERROR_IO_PENDING: Async lock is pending (effectively WouldBlock here).
            if code == ERROR_LOCK_VIOLATION || code == ERROR_IO_PENDING {
                return Ok(LockAttempt::WouldBlock);
            }
        }
        return Err(err);
    }

    Ok(LockAttempt::Acquired)
}
