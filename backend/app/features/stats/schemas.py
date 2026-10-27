import uuid
from datetime import date

from pydantic import BaseModel


class DayValue(BaseModel):
    day: date
    value: int


class FocusStats(BaseModel):
    total_minutes: int
    sessions: int
    completed: int
    cut_short: int
    # Per day in the range (every day, zeros included).
    daily_average_minutes: float
    current_streak: int
    longest_streak: int
    by_day: list[DayValue]
    # The 26 weeks (Monday first) up to the end of the range, for the heatmap.
    heatmap: list[DayValue]
    # Minutes per hour of the day, 0-23, by when sessions started.
    by_hour: list[int]


class TaskRef(BaseModel):
    task_id: uuid.UUID
    title: str
    minutes: int


class ProjectStats(BaseModel):
    project_id: uuid.UUID | None
    name: str
    color: str | None
    focus_minutes: int
    tasks_completed: int


class TaskStats(BaseModel):
    completed_by_day: list[DayValue]
    created: int
    completed: int
    overdue_now: int
    top_by_focus: list[TaskRef]


class AgentStats(BaseModel):
    runs_by_day: list[DayValue]
    runs: int
    # Document saves in the range, by who made them.
    documents_by_agents: int
    documents_by_you: int


class StatsOut(BaseModel):
    start: date
    end: date
    timezone: str
    focus: FocusStats
    tasks: TaskStats
    projects: list[ProjectStats]
    agents: AgentStats
