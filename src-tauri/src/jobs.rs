//! The programs the studio starts end with it. Claude Code and Codex run for minutes; a studio
//! that closes, crashes or is ended from the Task Manager must not leave them working on.
//!
//! Each one is put into a job object of the studio's, which Windows ends with everything in it
//! when its last handle closes: the studio's own, when the studio's process ends. A program the
//! studio starts after the fact (the installer of an update) is not in it.

use std::{ffi::c_void, sync::OnceLock};

use windows::Win32::{
    Foundation::HANDLE,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    },
};
use windows_core::PCWSTR;

/// The job's handle, as a number: a handle is not `Send`. None when Windows refused it.
static JOB: OnceLock<Option<usize>> = OnceLock::new();

fn job() -> Option<HANDLE> {
    let raw = *JOB.get_or_init(|| {
        // SAFETY: plain calls with no pointer kept beyond them: the job is unnamed and has the
        // default security; `info` lives until `SetInformationJobObject` returns, and its size is
        // the size passed. The handle is never closed: the process's end closes it.
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast::<c_void>(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).ok()?,
            )
            .ok()?;
            Some(job.0 as usize)
        }
    });
    raw.map(|raw| HANDLE(raw as *mut c_void))
}

/// Puts a program the studio started into the studio's job. A program that cannot be put there
/// still runs, as it would have without the job.
pub fn adopt(child: &tokio::process::Child) {
    let (Some(job), Some(process)) = (job(), child.raw_handle()) else {
        return;
    };
    // SAFETY: `process` is the handle of a child the caller holds, open for as long as `child`
    // is; the job's handle is open for the life of the process.
    let _ = unsafe { AssignProcessToJobObject(job, HANDLE(process)) };
}
