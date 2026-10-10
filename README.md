# Deepak Rajoriya — Task Manager

A personal, single-page Kanban task manager for organizing work without accounts, authentication, a database, or additional application pages. The application is built with PHP, HTML, jQuery, and browser JavaScript. PHP serves the page and reads/writes local JSON files.

## Project at a glance

- **Application:** one page served by `index.php`.
- **Board columns:** To Do, In Progress, Review, and Done.
- **Persistence:** `data/tasks.json` for tasks and comments; `data/task-settings.json` for global text-format defaults.
- **Backend:** PHP JSON endpoint in `index.php`, with file locking and atomic writes.
- **Frontend:** Tailwind CSS CDN, jQuery, Lucide icons, SortableJS, and project JavaScript modules.
- **Authentication:** none. The app is intended for personal use and is not a multi-user service.
- **Build step:** none.

## Folder structure

```text
task-manager/
├── index.php                  # Single-page UI and PHP JSON endpoint
├── README.md                  # Project and implementation handoff
├── assets/
│   ├── css/
│   │   └── style.css          # App styles, responsive layout, and custom controls
│   ├── images/
│   │   ├── logo.png           # Application logo
│   │   └── favicon.ico        # Browser favicon
│   └── js/
│       ├── app.js             # Board rendering, task interactions, reminders
│       ├── drawer.js          # Add/view/edit task drawer and comments UI
│       ├── dropdowns.js       # Custom select controls
│       ├── search.js          # Search and priority filtering
│       └── storage.js         # AJAX client, validation, and response normalization
└── data/
    ├── tasks.json             # Active and soft-deleted tasks (runtime data)
    ├── task-settings.json     # Global formatting defaults
    └── tasks.json.lock        # Runtime lock file for task-file operations
```

Do not reset or replace the JSON files when changing application code. They contain the user's live task data and preferences.

## Running locally

Run the folder through PHP and open `index.php` in a browser. For example, with the PHP executable bundled with XAMPP:

```powershell
C:\xampp-v2\php\php.exe -S 127.0.0.1:8000 -t C:\xampp-v2\htdocs\task-manager
```

Then visit `http://127.0.0.1:8000/index.php`. Apache/XAMPP can also serve the folder normally. PHP must be able to read and write the `data/` directory and create/open `data/tasks.json.lock`.

## Technology and external assets

The page loads its runtime dependencies directly from CDNs; there is no package manifest or compilation pipeline:

- Tailwind CSS CDN for layout and utility styling.
- Inter from Google Fonts.
- jQuery 3.7.1 for events, DOM changes, and AJAX.
- Lucide icons from `unpkg.com/lucide@latest`.
- SortableJS 1.15.6 for Kanban drag and drop.

Custom application styling belongs in `assets/css/style.css`. Keep the existing CDN-based setup unless a requested feature clearly requires changing it.

## Application design

The dashboard uses a compact, sticky header with the supplied brand mark, app name, local clock, task search, priority filter, Completed History, Trash (with a count), and Add Task actions. The board has four pastel status columns and compact task cards with priority, assignee, due-date, and action indicators. At narrow widths the board remains a horizontally scrollable four-column board; the header and controls reflow for mobile.

The task drawer is the only task workflow surface: it supports Add, View, and Edit modes, with Details and Comments tabs. Deleting a task moves it to Trash; Trash supports restore, individual permanent deletion, and Clear Trash. No action navigates to a separate task page.

## Features

- Four-column Kanban board with drag-and-drop status changes.
- Add, view, edit, soft-delete, restore, and permanently delete tasks.
- Bulk task selection and soft deletion.
- Search across title, description, assignee, priority, and tags, plus a global priority filter.
- Task comments with server-generated IDs and timestamps, fixed author display name `Deepak Rajoriya`, input trimming, empty/length validation (maximum 5,000 characters), and HTML-safe rendering.
- Task-specific title and description display formatting:
  - `uppercase`
  - `capital_case`
  - `sentence_case`
- Persistent global title and description formatting defaults for new tasks.
- Server and client trimming of title and description edges while retaining meaningful internal description whitespace.
- Assignee list is configured in PHP; Add Task defaults to the first configured assignee, and Unassigned remains available.
- Due date defaults to the user's current local date on new tasks. Due time is optional.
- Optional 5- or 10-minute reminders require both a due date and due time.
- Reminder popup stack with View Task, Mark as Done, and Dismiss; Notification API support when permission is granted.
- Overdue indicators, live local date/time, today's completed tasks on the board, and older completed tasks in Completed History.
- Responsive layout and custom dropdowns with keyboard navigation and native-select backing values.

## Task data

`data/tasks.json` is a JSON array. PHP normalizes legacy/missing optional task fields when reading stored records. A current task has this general shape:

```json
{
  "id": "task-example",
  "title": "Prepare a project update",
  "description": "Summarize progress and next steps.",
  "status": "todo",
  "priority": "medium",
  "due_date": "2026-10-15",
  "due_time": "",
  "reminder_minutes": null,
  "due_timezone": "",
  "assignee": "Deepak Rajoriya",
  "tags": ["Planning"],
  "text_format": {
    "title": "capital_case",
    "description": "sentence_case"
  },
  "comments": [],
  "deleted": false,
  "created_at": "2026-10-10T10:00:00+05:30",
  "updated_at": "2026-10-10T10:00:00+05:30"
}
```

Field notes:

- `id` is generated by PHP when a task is created. Clients should not choose or change it.
- `status` is one of `todo`, `in_progress`, `review`, or `done`.
- `priority` is `low`, `medium`, or `high`.
- `due_date` is `YYYY-MM-DD`; `due_time` is empty or `HH:MM`.
- `reminder_minutes` is `null`, `5`, or `10`. A time-based reminder also needs a valid IANA `due_timezone`.
- `text_format` belongs to the task and is not destructive: the original title/description remain stored as entered, apart from leading/trailing whitespace trimming.
- `comments` is a list of `{ "id", "author", "message", "created_at" }` records. Regular task edits do not replace this list.
- `deleted: true` means the task is in Trash. Permanent deletion removes that record and its comments.
- `completed_at` is maintained by the server when a task becomes Done; it may be absent on older records.

Global formatting preferences are stored separately in `data/task-settings.json`:

```json
{
  "text_format_defaults": {
    "title": "capital_case",
    "description": "sentence_case"
  }
}
```

Those defaults affect new tasks only. Existing tasks keep their own `text_format` values.

## PHP endpoint and persistence

`index.php` serves both the single-page HTML and its JSON endpoint. AJAX requests use the current page URL with `?ajax=1`.

### GET actions

| Request | Response purpose |
| --- | --- |
| `?ajax=1&action=list` | Active tasks |
| `?ajax=1&action=trash` | Soft-deleted tasks |
| `?ajax=1&action=settings` | Global text-format defaults |

### POST actions

POST requests must send JSON and the session CSRF token in `X-CSRF-Token`. Responses use `{ "success": boolean, "data": object|null, "message": string }`.

| `action` | Purpose |
| --- | --- |
| `create` | Validate fields and create a task; ID, timestamps, `deleted`, and initial `comments` are server-managed. |
| `update` | Validate editable fields for an active task; preserve other stored fields, including comments. |
| `add_comment` | Trim, validate, generate a unique comment ID/timestamp, and append one comment. |
| `soft_delete` | Move one active task to Trash. |
| `restore` | Restore one trashed task. |
| `permanent_delete` | Permanently remove one task, only when it is in Trash. |
| `bulk_soft_delete` | Soft-delete selected active tasks (maximum 100 IDs). |
| `clear_trash` | Permanently remove every task marked deleted and return removed IDs/count. |
| `save_text_format_defaults` | Persist global title/description formatting defaults. |

Task-file operations coordinate through `data/tasks.json.lock`; writes are performed using the existing safe-write helpers. Settings share the lock. Keep all task mutations server-validated—do not implement persistence by writing JSON directly from the browser.

## Reminder behavior and browser limits

Reminder time is calculated client-side from each task's due date, time, and stored timezone. The app checks while its page is open, catches up on timer delays and visibility/focus return, and stores reminder-cycle state in browser `localStorage` so a dismiss or handled reminder does not reappear for the same task deadline. A changed deadline/time/interval makes a different reminder cycle.

The Notification API can display desktop notifications over another active Chrome tab when permission is granted. Permission is requested through the reminder control in the task drawer. Clicking a notification focuses the existing app tab and opens the relevant task drawer. If permission is denied or unsupported, the in-app reminder stack remains available while the page is open.

**Reminders are not guaranteed when the app tab or browser is closed.** This implementation does not use a service worker, push subscription, or server-side scheduler. Background timer throttling can delay delivery; visibility/focus handling checks for missed reminders when the user returns.

## Code map

### `index.php`

- Defines allowed statuses, priorities, assignees, and formatting modes.
- Initializes task/settings storage and the shared lock.
- Contains task normalization, server-side validation, JSON responses, and task mutation actions.
- Renders the only page, including the dashboard, drawers, Trash, and Completed History.
- Loads CDN dependencies and project scripts in the page footer.

### `assets/js/storage.js`

- Central AJAX client; adds the CSRF header and validates server response envelopes.
- Normalizes task objects and validates task data before sending requests.
- Exposes task CRUD/Trash/comment operations and text-format default accessors as `window.TaskStorage`.

### `assets/js/drawer.js`

- Owns the right-side Add/View/Edit task drawer and Details/Comments tabs.
- Handles client validation, formatting controls, due date/time/reminder fields, and comments.
- Emits task-change events after successful server operations.

### `assets/js/app.js`

- Owns task collections, Kanban card/column rendering, counts, drag-and-drop, bulk selection/deletion, Trash, and history.
- Handles reminder timing, popup rendering/actions, Notification API interaction, and refresh/catch-up behavior.
- Exposes board access and refresh methods as `window.TaskApp`.

### `assets/js/search.js`

- Owns real-time search and priority filtering, the no-results state, and synchronization of search inputs.
- Coordinates with the board through its task collection and custom-filter events.

### `assets/js/dropdowns.js`

- Replaces the visual surface of native `<select>` elements with accessible custom dropdowns.
- Keeps the original selects as the value/event interface so form logic and filtering still use standard values.

### `assets/css/style.css`

- Holds shared component styles, custom dropdowns, drawers, responsive behavior, compact dashboard/card design, and reminder popups.
- Tailwind classes in `index.php` and JavaScript-rendered elements provide the remaining layout/styling.

## Conventions for future changes

1. Read the existing PHP and JavaScript flow before changing behavior; keep the single-page architecture.
2. Preserve user data in both JSON files. Never replace sample/live tasks to make a feature work.
3. For task fields, update server allowlists/defaults/validation, stored-task normalization, the `TaskStorage` normalizer and editable-field list, and drawer/card displays as applicable.
4. Keep comments and other server-managed fields out of general task-update payloads unless the endpoint specifically owns their mutation.
5. Use existing event handlers and delegated bindings; avoid binding the same handler during repeated renders.
6. Escape or use text nodes for user-provided content. Validate on the server even when the client also validates.
7. When changing a task mutation, verify that comments, formatting, reminders, Trash/restore, completion history, and drag-and-drop are preserved.
8. Use an isolated data copy for browser/API tests that create, edit, or delete tasks.
9. Run at least `php -l index.php` and `node --check` for changed JavaScript files. If possible, verify important UI flows in a browser at desktop and mobile widths.

## Helpful starting context for a future feature request

This is a personal, single-page PHP/jQuery Kanban app with a four-column board, a PHP JSON endpoint in `index.php`, and local JSON storage. Keep the current layout, task schema, data, and interactions intact. Trace related UI, JavaScript storage, and PHP validation together; reuse the existing endpoint and file-locking helpers. Do not add login, database storage, extra pages, a build step, or new dependencies unless explicitly requested.
