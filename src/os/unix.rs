#![deny(clippy::all)]

use crate::{Lock, LockAttempt};

pub type FileDescriptor = i32;
pub type Offset = u64;
pub type Length = u64;

// Linux 3.15+ provides OFD (open file description) locks via F_OFD_SETLK/SETLKW.
// OFD locks are scoped to the file description, not the process, so they are safe
// for multi-threaded use. On non-Linux platforms (macOS, BSD) we fall back to classic
// POSIX record locks (F_SETLK/F_SETLKW), which are process-scoped and have the
// close-any-fd-clears-all-locks caveat.
#[cfg(target_os = "linux")]
const SETLK_CMD: libc::c_int = 37; // F_OFD_SETLK
#[cfg(target_os = "linux")]
const SETLKW_CMD: libc::c_int = 38; // F_OFD_SETLKW

#[cfg(not(target_os = "linux"))]
const SETLK_CMD: libc::c_int = libc::F_SETLK;
#[cfg(not(target_os = "linux"))]
const SETLKW_CMD: libc::c_int = libc::F_SETLKW;

/// Acquire, release, or test a file lock.
///
/// When `range` is `Some`, uses `fcntl(2)` byte-range locks (OFD on Linux,
/// POSIX on macOS/BSD). When `range` is `None`, uses `flock(2)` for the
/// whole file. Set `blocking` to wait for contended locks.
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

        return fcntl_lock(fd, lock_type as libc::c_short, offset, len, blocking);
    }

    let mut flags = match lock {
        Lock::Exclusive => libc::LOCK_EX,
        Lock::Shared => libc::LOCK_SH,
        Lock::Unlock => libc::LOCK_UN,
    };

    if !blocking {
        flags |= libc::LOCK_NB;
    }

    flock(fd, flags)
}

/// Call flock(2), retrying on EINTR. Return WouldBlock on EWOULDBLOCK/EAGAIN.
fn flock(fd: i32, flags: i32) -> std::io::Result<LockAttempt> {
    loop {
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

/// Apply a byte-range lock via `fcntl(2)`. Uses OFD commands on Linux
/// and classic POSIX record-lock commands elsewhere.
fn fcntl_lock(
    fd: FileDescriptor,
    lock_type: libc::c_short,
    offset: Offset,
    len: Length,
    blocking: bool,
) -> std::io::Result<LockAttempt> {
    let mut fl: libc::flock = unsafe { std::mem::zeroed() };
    fl.l_type = lock_type;
    fl.l_whence = libc::SEEK_SET as libc::c_short;
    fl.l_start = offset as libc::off_t;
    fl.l_len = len as libc::off_t;
    // l_pid must remain 0 for OFD locks on Linux.

    let cmd = if blocking { SETLKW_CMD } else { SETLK_CMD };

    loop {
        let result = unsafe { libc::fcntl(fd, cmd, &mut fl) };
        if result == 0 {
            return Ok(LockAttempt::Acquired);
        }

        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(code) if code == libc::EINTR => continue,

            // Only treat contention as WouldBlock on the nonblocking path.
            Some(code) if !blocking && (code == libc::EACCES || code == libc::EAGAIN) => {
                return Ok(LockAttempt::WouldBlock);
            }

            _ => return Err(err),
        }
    }
}
