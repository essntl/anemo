"""Long field descriptions that several tools share are said once per request."""

from app.providers.base import ToolSpec
from app.tools.registry import all_tools
from app.tools.say_once import MIN_CHARS, say_once

LONG = "Properties, e.g. {client: x}: the keys and values list_properties shows, nothing else."
MORE = LONG + " Only the keys given change; null removes one."
SHORT = "The task's id"


def spec(name: str, **props: dict) -> ToolSpec:
    return ToolSpec(name=name, description=f"The {name} tool", input_schema={"properties": props})


def described(text: str, **extra) -> dict:
    return {"type": "string", "description": text, **extra}


def test_the_first_tool_keeps_the_words_and_the_others_point_to_it():
    assert len(LONG) >= MIN_CHARS
    a, b, c = say_once(
        [
            spec("create_task", properties=described(LONG), id=described(SHORT)),
            spec("update_task", properties=described(MORE, maxLength=5), id=described(SHORT)),
            spec("update_tasks", props=described(MORE), other=described(LONG)),
        ]
    )
    assert a.input_schema["properties"]["properties"]["description"] == LONG
    upd = b.input_schema["properties"]
    assert upd["properties"] == {
        "type": "string",
        "description": "As in create_task. Only the keys given change; null removes one.",
        "maxLength": 5,  # types and limits stay
    }
    assert upd["id"]["description"] == SHORT  # short ones are left alone
    many = c.input_schema["properties"]
    # The same addition again: the same words, pointing to where the text is.
    assert many["props"]["description"] == (
        "As in create_task (properties). Only the keys given change; null removes one."
    )
    assert many["other"]["description"] == "As in create_task (properties)."
    assert c.description == "The update_tasks tool"  # tool descriptions stay


def test_nested_definitions_and_a_property_named_description():
    item = {"properties": {"text": described(LONG)}, "description": LONG + " An item."}
    first, second = say_once(
        [
            spec("a", description=described(LONG)),
            ToolSpec(
                name="b",
                description="b",
                input_schema={
                    "$defs": {"Item": item},
                    "properties": {"x": {"$ref": "#/$defs/Item"}},
                },
            ),
        ]
    )
    # A property called "description" is a property, not the keyword.
    assert first.input_schema["properties"]["description"]["description"] == LONG
    defs = second.input_schema["$defs"]["Item"]
    assert defs["properties"]["text"]["description"] == "As in a (description)."
    assert defs["description"] == "As in a (description). An item."


def test_the_same_toolset_gives_the_same_bytes_and_one_tool_alone_is_unchanged():
    tools = sorted((t for t in all_tools() if not t.hidden), key=lambda t: t.name)
    names = frozenset(t.name for t in tools)
    once = say_once([t.spec(names) for t in tools])
    again = say_once([t.spec(names) for t in tools])
    assert [s.model_dump() for s in once] == [s.model_dump() for s in again]
    alone = all_tools()[0].spec()
    assert say_once([alone]) == [alone]
    # Every pointer names a tool of the same request.
    text = str([s.input_schema for s in once])
    for pointer in text.split("As in ")[1:]:
        assert pointer.split(".")[0].split(" ")[0] in names
