use std::process::Command;

/// Get the current git branch for a directory.
/// Tries `git symbolic-ref --short HEAD` first (for normal branches),
/// then falls back to `git rev-parse --short HEAD` (for detached HEAD).
/// Returns None if the directory is not a git repository.
pub fn get_branch(dir: &str) -> Option<String> {
    // Try symbolic-ref first (gives branch name like "main")
    let output = Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() {
            return Some(branch);
        }
    }

    // Fall back to rev-parse (gives short commit hash for detached HEAD)
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()?;

    if output.status.success() {
        let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !hash.is_empty() {
            return Some(hash);
        }
    }

    None
}

/// Check whether the given directory is inside a git repository.
pub fn is_git_repo(dir: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the current working tree diff against HEAD.
/// Includes both staged and unstaged changes.
pub fn get_diff(dir: &str) -> Result<String, String> {
    if !is_git_repo(dir) {
        return Err(format!("{dir} is not a git repository"));
    }

    let output = Command::new("git")
        .args(["--no-pager", "diff", "--no-ext-diff", "HEAD"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to spawn git diff: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tmp_is_not_git_repo() {
        assert!(!is_git_repo("/tmp"), "/tmp should not be a git repo");
        assert_eq!(
            get_branch("/tmp"),
            None,
            "get_branch on /tmp should return None"
        );
    }
}
