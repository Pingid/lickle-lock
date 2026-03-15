#![deny(clippy::all)]

use crate::{Lock, LockAttempt};

pub type FileDescriptor = i32;
pub type Offset = u64;
pub type Length = u64;

/// F_OFD_SETLK: Open File Description locks (Linux 3.15+).
/// Falls back to traditional POSIX F_SETLK on macOS/BSD.
#[cfg(target_os = "linux")]
const SETLK_OFD: libc::c_int = 37;
#[cfg(not(target_os = "linux"))]
const SETLK_OFD: libc::c_int = libc::F_SETLK;

pub fn file_lock(
    fd: FileDescriptor,
    lock: Lock,
    range: Option<(Offset, Length)>,
    blocking: bool,
) -> std::io::Result<LockAttempt> {
    if let Some((offset, len)) = range {
        let lock_type = match lock {
            Lock::Exclusive => libc::F_WRLCK,
            Lock::Shared => libc::F_RDLCK,
            Lock::Unlock => libc::F_UNLCK,
        };
        return fcntl_lock(fd, lock_type as libc::c_short, offset, len);
    }

    let mut flag = match lock {
        Lock::Exclusive => libc::LOCK_EX,
        Lock::Shared => libc::LOCK_SH,
        Lock::Unlock => libc::LOCK_UN,
    };
    if !blocking {
        flag |= libc::LOCK_NB;
    }
    flock(fd, flag)
}

/// Call flock(2), retrying on EINTR. Return WouldBlock on EWOULDBLOCK/EAGAIN.
fn flock(fd: i32, flags: i32) -> std::io::Result<LockAttempt> {
    loop {
        // SAFETY: fd is a valid open file descriptor supplied by the caller.
        // LOCK_EX | LOCK_NB, LOCK_SH | LOCK_NB, and LOCK_UN are valid flock(2) flags.
        let result = unsafe { libc::flock(fd, flags) };
        if result == 0 {
            return Ok(LockAttempt::Acquired);
        }

        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(code) if code == libc::EINTR => continue,
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => {
                return Ok(LockAttempt::WouldBlock);
            }
            _ => return Err(err),
        }
    }
}

/// Apply a byte-range lock via fcntl OFD locks. Retry on EINTR.
fn fcntl_lock(
    fd: FileDescriptor,
    lock_type: libc::c_short,
    offset: Offset,
    len: Length,
) -> std::io::Result<LockAttempt> {
    // SAFETY: flock is a plain C struct with no padding requirements beyond zeroed initialisation.
    let mut fl: libc::flock = unsafe { std::mem::zeroed() };
    fl.l_type = lock_type;
    fl.l_whence = libc::SEEK_SET as libc::c_short;
    fl.l_start = offset as libc::off_t;
    fl.l_len = len as libc::off_t;
    // l_pid stays 0 from zeroed — required for OFD locks

    loop {
        // SAFETY: fl is fully initialised above. fd is a valid open file descriptor.
        // SETLK_OFD (F_OFD_SETLK on Linux, F_SETLK elsewhere) is a valid fcntl cmd.
        let result = unsafe { libc::fcntl(fd, SETLK_OFD, &mut fl) };
        if result == 0 {
            return Ok(LockAttempt::Acquired);
        }

        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(code) if code == libc::EINTR => continue,
            Some(code) if code == libc::EACCES || code == libc::EAGAIN => {
                return Ok(LockAttempt::WouldBlock);
            }
            _ => return Err(err),
        }
    }
}
