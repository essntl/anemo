import uuid

from pydantic import BaseModel, Field

COLOR = r"^#[0-9a-fA-F]{6}$"


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field("#6b7280", pattern=COLOR)
    archived: bool = False
    # Extra instructions for the assistant in every chat of this project.
    instructions: str = Field("", max_length=20_000)
    # What a new chat in this project starts with (None: the normal defaults).
    default_model_id: uuid.UUID | None = None
    default_profile_id: uuid.UUID | None = None


class ProjectOut(ProjectIn):
    id: uuid.UUID
    slug: str  # the project's folder name; does not change when it is renamed
    files_path: str  # workspace folder with the project's files
    documents_path: str  # workspace folder with the project's documents
    open_tasks: int = 0
    chats: int = 0
    events: int = 0  # upcoming or repeating
    documents: int = 0
