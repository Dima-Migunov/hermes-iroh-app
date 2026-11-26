use std::time::Duration;

/// Base delays for consecutive automatic connection attempts.
pub const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(20),
];

/// Fraction of the base delay that jitter may add or remove.
pub const RETRY_JITTER: f64 = 0.2;

/// Hard upper bound for a single retry delay.
pub const RETRY_CAP: Duration = Duration::from_secs(20);

/// A pure backoff schedule. The delay for a failed attempt is derived from the number of
/// consecutive failures, so the policy has no clock, task, or transport dependencies.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    delays: Vec<Duration>,
    jitter: f64,
    cap: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::production()
    }
}

impl RetryPolicy {
    pub fn new(delays: Vec<Duration>, jitter: f64, cap: Duration) -> Self {
        assert!(
            !delays.is_empty(),
            "a retry policy needs at least one delay"
        );
        Self {
            delays,
            jitter: jitter.clamp(0.0, 1.0),
            cap,
        }
    }

    /// The production schedule: 1, 2, 5, 10, then 20 seconds with ±20% jitter and a 20 s cap.
    pub fn production() -> Self {
        Self::new(RETRY_DELAYS.to_vec(), RETRY_JITTER, RETRY_CAP)
    }

    /// The delay after `failures` consecutive failed attempts. The index is clamped to the
    /// last step, so every later failure waits at the final base delay.
    pub fn delay(&self, failures: usize) -> Duration {
        let base = self.delays[failures.min(self.delays.len() - 1)];
        let jittered = if self.jitter == 0.0 {
            base
        } else {
            let factor = 1.0 + rand::random_range(-self.jitter..=self.jitter);
            base.mul_f64(factor)
        };
        jittered.min(self.cap)
    }

    /// Number of distinct base delays in the schedule.
    pub fn steps(&self) -> usize {
        self.delays.len()
    }

    /// The base delay at `index`, clamped to the last step.
    pub fn base_delay(&self, index: usize) -> Duration {
        self.delays[index.min(self.delays.len() - 1)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_policy(jitter: f64, cap: Duration) -> RetryPolicy {
        RetryPolicy::new(RETRY_DELAYS.to_vec(), jitter, cap)
    }

    #[test]
    fn follows_the_documented_sequence_without_jitter() {
        let policy = fixed_policy(0.0, RETRY_CAP);
        let delays: Vec<Duration> = (0..7).map(|failures| policy.delay(failures)).collect();
        assert_eq!(
            delays,
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(5),
                Duration::from_secs(10),
                Duration::from_secs(20),
                Duration::from_secs(20),
                Duration::from_secs(20),
            ]
        );
    }

    #[test]
    fn clamps_large_failure_counts_to_the_last_step() {
        let policy = fixed_policy(0.0, RETRY_CAP);
        assert_eq!(policy.delay(usize::MAX), Duration::from_secs(20));
        assert_eq!(policy.base_delay(usize::MAX), Duration::from_secs(20));
    }

    #[test]
    fn jitter_never_exceeds_the_cap_or_drops_below_the_lower_bound() {
        let policy = fixed_policy(RETRY_JITTER, RETRY_CAP);
        for failures in 0..10 {
            for _ in 0..200 {
                let delay = policy.delay(failures);
                assert!(delay <= RETRY_CAP, "delay {delay:?} exceeded the 20 s cap");
                let lower_bound = policy.base_delay(failures).mul_f64(0.8);
                assert!(
                    delay >= lower_bound,
                    "delay {delay:?} fell below the jitter lower bound {lower_bound:?}"
                );
            }
        }
    }

    #[test]
    fn zero_jitter_is_deterministic() {
        let policy = fixed_policy(0.0, RETRY_CAP);
        for failures in 0..5 {
            assert_eq!(policy.delay(failures), policy.delay(failures));
        }
    }

    #[test]
    fn a_small_cap_wins_over_jitter() {
        let cap = Duration::from_millis(500);
        let policy = fixed_policy(0.0, cap);
        assert_eq!(policy.delay(0), cap);
        assert_eq!(policy.delay(4), cap);
    }

    #[test]
    fn reports_the_number_of_steps() {
        assert_eq!(RetryPolicy::production().steps(), 5);
    }
}
