"""A stand-in for the artemk.no booking tools (spec 02 section 3), served as a real MCP
server by tests/mcp_server.py. It never touches the live site: its bookings are what the
test puts in `Artemk.bookings`, and it records every call it gets.

- `open_requests`, `upcoming_appointments` and `list_bookings` are read-only (they say
  so in their MCP annotations), and return what a booking system would, customer contact
  details included.
- `confirm_booking` and `suggest_new_time` write to the booking system and reach the
  customer. They only record that they were called (`Artemk.contacted`)."""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

SERVER = "artemk"  # its name in Anemo, so its tools are mcp__artemk__<tool>
READ_ONLY = ("open_requests", "upcoming_appointments", "list_bookings")
CONTACT = ("confirm_booking", "suggest_new_time")


def tool(name: str) -> str:
    """The name an Anemo run calls the tool by."""
    return f"mcp__{SERVER}__{name}"


@dataclass
class Customer:
    name: str
    phone: str
    email: str
    address: str

    def details(self) -> list[str]:
        return [self.name, self.phone, self.email, self.address]


@dataclass
class Booking:
    id: int
    service: str
    start: datetime  # local time
    customer: Customer
    home_visit: bool = False
    status: str = "requested"  # requested | confirmed | cancelled | declined
    note: str = ""

    def out(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "service": self.service,
            "start": self.start.isoformat(timespec="minutes"),
            "home_visit": self.home_visit,
            "status": self.status,
            "customer": vars(self.customer),
            "note": self.note,
            "admin_url": admin_url(self.id),
        }


def admin_url(booking_id: int) -> str:
    return f"https://artemk.no/admin/bookings/{booking_id}"


@dataclass
class Artemk:
    bookings: list[Booking] = field(default_factory=list)
    # Every call, in order: (tool, arguments).
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    # Set: open_requests fails with this message (an outage that quotes a booking, say).
    fail_with: str | None = None

    @property
    def contacted(self) -> list[tuple[str, dict[str, Any]]]:
        """The calls that would have written to the booking system or reached a customer."""
        return [c for c in self.calls if c[0] in CONTACT]

    def booking(self, booking_id: int) -> Booking:
        return next(b for b in self.bookings if b.id == booking_id)

    def server(self) -> MCPServer:
        server = MCPServer(SERVER)
        read_only = ToolAnnotations(read_only_hint=True)

        def listing(found: list[Booking]) -> str:
            return json.dumps([b.out() for b in found], ensure_ascii=False)

        @server.tool(annotations=read_only)
        def open_requests() -> str:
            """Booking requests that wait for an answer."""
            self.calls.append(("open_requests", {}))
            if self.fail_with:
                raise ToolError(self.fail_with)
            return listing([b for b in self.bookings if b.status == "requested"])

        @server.tool(annotations=read_only)
        def upcoming_appointments() -> str:
            """Confirmed bookings that haven't happened yet."""
            self.calls.append(("upcoming_appointments", {}))
            now = datetime.now()
            return listing([b for b in self.bookings if b.status == "confirmed" and b.start >= now])

        @server.tool(annotations=read_only)
        def list_bookings(from_date: str) -> str:
            """Requests and bookings (any status) from this day on (YYYY-MM-DD)."""
            self.calls.append(("list_bookings", {"from_date": from_date}))
            return listing([b for b in self.bookings if b.start.date().isoformat() >= from_date])

        @server.tool()
        def confirm_booking(booking_id: int) -> str:
            """Confirm a booking request; the customer gets an SMS and an email."""
            self.calls.append(("confirm_booking", {"booking_id": booking_id}))
            return f"Booking {booking_id} confirmed; the customer was told."

        @server.tool()
        def suggest_new_time(booking_id: int, start: str, message: str = "") -> str:
            """Suggest another time to the customer (by SMS)."""
            self.calls.append(
                ("suggest_new_time", {"booking_id": booking_id, "start": start, "message": message})
            )
            return f"Suggested {start} to the customer of booking {booking_id}."

        return server
