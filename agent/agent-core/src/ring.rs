//! The replay ring: discrete events only. Progress is coalesced elsewhere.

use crate::wire::EventFrame;
use std::collections::VecDeque;

/// The answer to a resync request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResyncPlan {
    /// First sequence number the requester is missing.
    pub from_seq: u64,
    /// Newest sequence number held.
    pub to_seq: u64,
    /// The ring no longer reaches back to what the requester has: rebuild from the snapshot.
    pub gap: bool,
    /// Events to replay, oldest first.
    pub events: Vec<EventFrame>,
}

/// Keeps the newest `capacity` discrete events.
#[derive(Debug, Clone)]
pub struct ReplayRing {
    capacity: usize,
    events: VecDeque<EventFrame>,
    head: u64,
}

impl ReplayRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            events: VecDeque::new(),
            head: 0,
        }
    }

    /// The newest sequence number, or 0 when nothing was recorded yet.
    pub fn head_seq(&self) -> u64 {
        self.head
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Records an event. Sequence numbers must increase by one.
    pub fn push(&mut self, event: EventFrame) {
        self.head = event.seq;
        self.events.push_back(event);
        while self.events.len() > self.capacity {
            self.events.pop_front();
        }
    }

    /// Plans the answer to `resync(last_seq)`.
    pub fn plan(&self, last_seq: u64) -> ResyncPlan {
        let to_seq = self.head;
        if last_seq >= to_seq {
            return ResyncPlan {
                from_seq: to_seq + 1,
                to_seq,
                gap: false,
                events: Vec::new(),
            };
        }
        let oldest = self.events.front().map_or(to_seq + 1, |e| e.seq);
        if last_seq + 1 >= oldest {
            return ResyncPlan {
                from_seq: last_seq + 1,
                to_seq,
                gap: false,
                events: self
                    .events
                    .iter()
                    .filter(|e| e.seq > last_seq)
                    .cloned()
                    .collect(),
            };
        }
        ResyncPlan {
            from_seq: oldest,
            to_seq,
            gap: true,
            events: self.events.iter().cloned().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{EventBody, Step};

    fn ev(seq: u64) -> EventFrame {
        EventFrame {
            seq,
            body: EventBody::Step {
                step: Step::Copying,
            },
        }
    }

    fn ring(cap: usize, n: u64) -> ReplayRing {
        let mut r = ReplayRing::new(cap);
        for s in 1..=n {
            r.push(ev(s));
        }
        r
    }

    #[test]
    fn an_empty_ring_has_head_zero_and_nothing_to_replay() {
        let r = ReplayRing::new(8);
        let p = r.plan(0);
        assert_eq!((r.head_seq(), p.gap, p.events.len()), (0, false, 0));
    }

    #[test]
    fn a_requester_that_is_caught_up_gets_nothing() {
        let p = ring(8, 5).plan(5);
        assert!(!p.gap && p.events.is_empty());
        assert_eq!((p.from_seq, p.to_seq), (6, 5));
    }

    #[test]
    fn a_requester_behind_by_a_few_events_gets_exactly_the_later_ones() {
        let p = ring(8, 5).plan(2);
        assert!(!p.gap);
        assert_eq!((p.from_seq, p.to_seq), (3, 5));
        assert_eq!(
            p.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
    }

    #[test]
    fn a_new_requester_gets_the_whole_ring_when_nothing_was_evicted() {
        let p = ring(8, 5).plan(0);
        assert!(!p.gap);
        assert_eq!(p.events.len(), 5);
    }

    #[test]
    fn the_ring_evicts_the_oldest_events_beyond_its_capacity() {
        let r = ring(4, 10);
        assert_eq!(r.len(), 4);
        assert_eq!(r.head_seq(), 10);
    }

    #[test]
    fn a_requester_older_than_the_ring_gets_a_gap_marker_and_the_retained_events() {
        let p = ring(4, 10).plan(3);
        assert!(p.gap);
        assert_eq!((p.from_seq, p.to_seq), (7, 10));
        assert_eq!(p.events.len(), 4);
    }

    #[test]
    fn a_requester_exactly_at_the_edge_of_the_ring_has_no_gap() {
        let p = ring(4, 10).plan(6);
        assert!(!p.gap);
        assert_eq!(p.events.first().unwrap().seq, 7);
    }

    #[test]
    fn a_requester_claiming_a_future_sequence_is_treated_as_caught_up() {
        let p = ring(8, 5).plan(99);
        assert!(!p.gap && p.events.is_empty());
    }
}
