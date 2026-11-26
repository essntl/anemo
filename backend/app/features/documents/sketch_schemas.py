"""What the API says about a sketch (shared by the documents router and the sketch one)."""

from pydantic import BaseModel, Field

from app.features.documents.sketch import SketchData
from app.features.documents.sketches import SketchState


class PreviewOut(BaseModel):
    drawing_hash: str = Field(description="The drawing version the image shows")
    width: int
    height: int


class SketchOut(BaseModel):
    data: SketchData | None = Field(description="The drawing; None when it can't be read")
    error: str | None = Field(None, description="Why the drawing can't be read")
    drawing_hash: str | None = Field(None, description="This version of the drawing")
    transcription: str | None = Field(None, description="Text a model read from the drawing")
    transcription_current: bool = Field(
        False, description="The transcription was made from the drawing as it is now"
    )
    transcription_status: str | None = Field(None, description="queued | failed | None")
    preview: PreviewOut | None = None
    preview_current: bool = Field(False, description="The image shows the drawing as it is now")


def sketch_out(s: SketchState) -> SketchOut:
    preview = (
        PreviewOut(
            drawing_hash=s.preview.drawing_hash, width=s.preview.width, height=s.preview.height
        )
        if s.preview
        else None
    )
    return SketchOut(
        data=s.data,
        error=s.error,
        drawing_hash=s.drawing_hash,
        transcription=s.transcription,
        transcription_current=s.transcription_current,
        transcription_status=s.transcription_status,
        preview=preview,
        preview_current=s.preview_current,
    )
