import asyncio
from typing import Dict, Any, List

class ProgressTracker:
    def __init__(self):
        self.listeners: List[asyncio.Queue] = []
        self.data = {
            "stage": "idle",  # idle, filtering, scoring, ranking, completed, failed
            "logs": [],
            "filter": {"current": 0, "total": 0, "status": "idle"}, # idle, running, completed
            "scorer": {"current": 0, "total": 0, "status": "idle"},
            "ranker": {"current": 0, "total": 0, "status": "idle"},
        }
        
    def update(self, **kwargs):
        for k, v in kwargs.items():
            if isinstance(v, dict) and k in self.data and isinstance(self.data[k], dict):
                self.data[k].update(v)
            else:
                self.data[k] = v
        self.notify()

    def add_log(self, message: str):
        self.data["logs"].append(message)
        self.notify()

    def notify(self):
        # Create a snapshot to send
        snapshot = {
            "stage": self.data["stage"],
            "logs": list(self.data["logs"]),
            "filter": dict(self.data["filter"]),
            "scorer": dict(self.data["scorer"]),
            "ranker": dict(self.data["ranker"]),
        }
        for queue in self.listeners:
            try:
                queue.put_nowait(snapshot)
            except Exception:
                pass
            
    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue()
        self.listeners.append(q)
        # Immediately push current state
        q.put_nowait(self.data.copy())
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self.listeners:
            self.listeners.remove(q)

# Global in-memory dictionary of active jobs
active_jobs: Dict[str, ProgressTracker] = {}

def get_tracker(job_id: str) -> ProgressTracker:
    if job_id not in active_jobs:
        active_jobs[job_id] = ProgressTracker()
    return active_jobs[job_id]
