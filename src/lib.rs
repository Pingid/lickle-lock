#![deny(clippy::all)]

use napi_derive::napi;
use std::time::{Duration, Instant};

mod os;

#[napi]
pub async fn exclusive(
    fd: os::FileDescriptor,
    options: Option<PollFlockOptions>,
) -> napi::Result<()> {
    poll_lock(options, move || os::try_lock_exclusive(fd))
        .await
        .map(|_| {})
}

#[napi]
pub async fn try_exclusive(fd: os::FileDescriptor) -> napi::Result<bool> {
    try_lock_async(fd, os::try_lock_exclusive)
        .await
        .map(|attempt| matches!(attempt, LockAttempt::Acquired))
}

#[napi]
pub async fn shared(fd: os::FileDescriptor, options: Option<PollFlockOptions>) -> napi::Result<()> {
    poll_lock(options, move || os::try_lock_shared(fd))
        .await
        .map(|_| {})
}

#[napi]
pub async fn try_shared(fd: os::FileDescriptor) -> napi::Result<bool> {
    try_lock_async(fd, os::try_lock_shared)
        .await
        .map(|attempt| matches!(attempt, LockAttempt::Acquired))
}

#[napi]
pub fn unlock(fd: os::FileDescriptor) -> napi::Result<()> {
    os::unlock(fd)?;
    Ok(())
}

async fn try_lock_async(
    fd: os::FileDescriptor,
    f: impl FnOnce(os::FileDescriptor) -> std::io::Result<LockAttempt> + Send + Clone + 'static,
) -> napi::Result<LockAttempt> {
    tokio::task::spawn_blocking(move || f(fd))
        .await
        .map_err(|e| napi::Error::from_reason(e.to_string()))
        .and_then(|result| result.map_err(|e| napi::Error::from_reason(e.to_string())))
}

#[napi(object)]
pub struct PollFlockOptions {
    pub poll_ms: Option<u32>,
    pub timeout: Option<u32>,
}

pub(crate) async fn poll_lock(
    options: Option<PollFlockOptions>,
    attempt_lock: impl Fn() -> std::io::Result<LockAttempt> + Send + Clone + 'static,
) -> napi::Result<()> {
    let poll_ms = options.as_ref().and_then(|o| o.poll_ms).unwrap_or(10) as u64;
    let timeout = options
        .as_ref()
        .and_then(|o| o.timeout)
        .map(|t| Duration::from_millis(t as u64));
    let start = Instant::now();

    loop {
        // 1. Clone the closure so we have a fresh copy for this iteration
        let attempt = attempt_lock.clone();

        // 2. Pass the cloned closure to spawn_blocking
        let locked = tokio::task::spawn_blocking(attempt)
            .await
            .map_err(|e| napi::Error::from_reason(e.to_string()))??;

        if matches!(locked, LockAttempt::Acquired) {
            return Ok(());
        }
        if let Some(timeout) = timeout {
            if start.elapsed() >= timeout {
                return Err(napi::Error::from_reason("Timed out acquiring lock"));
            }
        }
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}

pub(crate) enum LockAttempt {
    Acquired,
    WouldBlock,
}
