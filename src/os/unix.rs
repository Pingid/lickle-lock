#![deny(clippy::all)]

use crate::LockAttempt;

pub type FileDescriptor = i32;

pub fn try_lock_exclusive(fd: FileDescriptor) -> std::io::Result<LockAttempt> {
    try_lock(fd, libc::LOCK_EX | libc::LOCK_NB)
}

pub fn try_lock_shared(fd: FileDescriptor) -> std::io::Result<LockAttempt> {
    try_lock(fd, libc::LOCK_SH | libc::LOCK_NB)
}

pub fn unlock(fd: FileDescriptor) -> std::io::Result<()> {
    try_lock(fd, libc::LOCK_UN)?;
    Ok(())
}

fn try_lock(fd: i32, flags: i32) -> std::io::Result<LockAttempt> {
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
