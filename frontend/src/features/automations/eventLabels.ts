/**
 * The words of the server's event catalogue (backend app/features/triggers/catalogue.py),
 * marked here so they are translated: the dialog shows them with `t(...)`. A label the
 * server adds later and that is not listed here is shown in English.
 */
import { msg } from '@/lib/i18n'

export const EVENT_WORDS = [
  // event types
  msg('Task created'), msg('Task changed'), msg('Task completed'), msg('Task deleted'),
  msg('Event created'), msg('Event changed'), msg('Event deleted'),
  msg('Document created'), msg('Document changed'), msg('Document deleted'),
  msg('Claude Code job started'), msg('Claude Code job ended'),
  msg('Device online'), msg('Device offline'), msg('File added'),
  msg('Automation failed'), msg('Approval waiting'), msg('Webhook'), msg('MCP server notification'),
  // what they are
  msg('A task was created.'),
  msg('A task was changed (fields: the names of what changed).'),
  msg('A task was marked done.'),
  msg('A task was moved to the trash.'),
  msg('A calendar event was created.'),
  msg('A calendar event was changed (fields: the names of what changed).'),
  msg('A calendar event was moved to the trash.'),
  msg('A document was created.'),
  msg('A document’s text, title or place changed.'),
  msg('A document was moved to the trash.'),
  msg('A Claude Code job started on one of your computers.'),
  msg('A Claude Code job ended: done, failed, cancelled or exited without a result.'),
  msg('A computer or phone connected.'),
  msg('A computer or phone disconnected.'),
  msg('A new file appeared in the workspace through Anemo (an upload, an agent, the extension).'),
  msg('An automation’s run failed for good (after its retries).'),
  msg('A run is waiting for your approval.'),
  msg('Another service called this trigger’s webhook URL (signed with its secret).'),
  msg('A connected MCP server sent a notification (a resource changed, its tools changed…).'),
  // the fields a filter can name
  msg('Task'), msg('Title'), msg('Status'), msg('Project'), msg('Tag'), msg('Priority'),
  msg('Parent task'), msg('Changed field'), msg('Event'), msg('Document'), msg('Path'),
  msg('Job'), msg('Thread'), msg('Computer'), msg('Computer name'), msg('Project folder'),
  msg('Chat that started it'), msg('How it ended'), msg('Device'), msg('Name'), msg('Kind'),
  msg('Type'), msg('Automation'), msg('Run'), msg('Chat'), msg('Tool'), msg('Content type'),
  msg('MCP server'), msg('Notification'), msg('Resource URI'),
] as const
