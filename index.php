<?php
/**
 * Personal Kanban Task Manager
 * Single-page application and JSON storage endpoint.
 */

ini_set('display_errors', '0');
error_reporting(E_ALL);
session_start();
if (empty($_SESSION['task_manager_csrf_token'])) {
    $_SESSION['task_manager_csrf_token'] = bin2hex(random_bytes(32));
}
$csrfToken = $_SESSION['task_manager_csrf_token'];

$dataDirectory = __DIR__ . '/data';
$tasksFile = $dataDirectory . '/tasks.json';
$tasksLockFile = $dataDirectory . '/tasks.json.lock';
$taskStatuses = ['todo', 'in_progress', 'review', 'done'];
$taskPriorities = ['low', 'medium', 'high'];
$taskTextFormats = ['uppercase', 'capital_case', 'sentence_case'];
$defaultTextFormats = [
    'title' => 'capital_case',
    'description' => 'sentence_case',
];
$initialTextFormats = $defaultTextFormats;
$settingsFile = $dataDirectory . '/task-settings.json';
$taskAssignees = [
    'Deepak Rajoriya',
];

class TaskNotFoundException extends RuntimeException
{
}

function sendJsonResponse(int $status, bool $success, $data, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    $json = json_encode(
        ['success' => $success, 'data' => $data, 'message' => $message],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );
    echo $json === false
        ? '{"success":false,"data":null,"message":"Could not encode the response."}'
        : $json;
    exit;
}

function escapeHtml($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function ensureTaskStore(string $directory, string $path, string $lockPath): void
{
    if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) {
        throw new RuntimeException('The task data directory could not be created.');
    }

    $lockHandle = fopen($lockPath, 'c+b');
    if ($lockHandle === false) {
        throw new RuntimeException('The task data lock file could not be opened. Check data directory permissions.');
    }

    try {
        if (!flock($lockHandle, LOCK_EX)) {
            throw new RuntimeException('The task data file could not be locked.');
        }

        if (!file_exists($path)) {
            $handle = fopen($path, 'x+b');
            if ($handle === false) {
                throw new RuntimeException('The task data file could not be initialized.');
            }

            try {
                if (fwrite($handle, "[]\n") === false || !fflush($handle)) {
                    throw new RuntimeException('The task data file could not be initialized.');
                }
            } finally {
                fclose($handle);
            }
        }
    } finally {
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
    }
}

function normalizeStoredTask($task): array
{
    global $taskStatuses, $taskPriorities, $taskTextFormats, $initialTextFormats;

    if (
        !is_array($task)
        || !isset($task['id'])
        || !is_string($task['id'])
        || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/', $task['id'])
    ) {
        throw new RuntimeException('A task record in the JSON file is invalid.');
    }

    $status = isset($task['status']) && is_string($task['status']) ? $task['status'] : 'todo';
    $priority = isset($task['priority']) && is_string($task['priority']) ? $task['priority'] : 'medium';
    if (!in_array($status, $taskStatuses, true) || !in_array($priority, $taskPriorities, true)) {
        throw new RuntimeException('A task record has an invalid status or priority.');
    }

    $tags = $task['tags'] ?? [];
    if (!is_array($tags)) {
        $tags = [];
    }
    $textFormat = $task['text_format'] ?? [];
    if (!is_array($textFormat)) {
        throw new RuntimeException('A task record has invalid text formatting preferences.');
    }
    $normalizedTextFormat = [];
    foreach (['title', 'description'] as $field) {
        $format = $textFormat[$field] ?? $initialTextFormats[$field];
        if (!is_string($format) || !in_array($format, $taskTextFormats, true)) {
            throw new RuntimeException('A task record has invalid text formatting preferences.');
        }
        $normalizedTextFormat[$field] = $format;
    }
    $comments = $task['comments'] ?? [];
    if (!is_array($comments) || array_values($comments) !== $comments) {
        throw new RuntimeException('A task record has an invalid comments list.');
    }
    $normalizedComments = [];
    foreach ($comments as $comment) {
        if (
            !is_array($comment)
            || !is_string($comment['id'] ?? null)
            || !preg_match('/^comment-[A-Fa-f0-9]{16,64}$/', $comment['id'])
            || !is_string($comment['author'] ?? null)
            || trim($comment['author']) === ''
            || !is_string($comment['message'] ?? null)
            || trim($comment['message']) === ''
            || !is_string($comment['created_at'] ?? null)
            || strtotime($comment['created_at']) === false
        ) {
            throw new RuntimeException('A task record contains an invalid comment.');
        }
        $messageLength = preg_match_all('/./us', $comment['message']);
        if ($messageLength === false || $messageLength > 5000) {
            throw new RuntimeException('A stored task comment exceeds the allowed length.');
        }
        $normalizedComments[] = [
            'id' => $comment['id'],
            'author' => $comment['author'],
            'message' => $comment['message'],
            'created_at' => $comment['created_at'],
        ];
    }
    $reminderMinutes = $task['reminder_minutes'] ?? null;
    if ($reminderMinutes !== null && $reminderMinutes !== 5 && $reminderMinutes !== 10) {
        throw new RuntimeException('A task record has an invalid reminder interval.');
    }
    $dueTime = is_string($task['due_time'] ?? null) ? $task['due_time'] : '';
    $dueTimezone = is_string($task['due_timezone'] ?? null) ? $task['due_timezone'] : '';
    $storedDueDate = is_string($task['due_date'] ?? null) ? $task['due_date'] : '';
    if ($dueTime !== '' && !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $dueTime)) {
        throw new RuntimeException('A task record has an invalid due time.');
    }
    if ($dueTime !== '') {
        try {
            new DateTimeZone($dueTimezone);
        } catch (Throwable $error) {
            throw new RuntimeException('A task record has an invalid due-time timezone.');
        }
        if ($storedDueDate === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $storedDueDate)) {
            throw new RuntimeException('A task record has a due time without a valid due date.');
        }
    }
    if ($reminderMinutes !== null && ($dueTime === '' || ($task['due_date'] ?? '') === '' || $dueTimezone === '')) {
        throw new RuntimeException('A task reminder is missing its due date, time, or timezone.');
    }

    $normalized = [
        'id' => $task['id'],
        'title' => is_string($task['title'] ?? null) ? $task['title'] : '',
        'description' => is_string($task['description'] ?? null) ? $task['description'] : '',
        'status' => $status,
        'priority' => $priority,
        'due_date' => $storedDueDate,
        'due_time' => $dueTime,
        'reminder_minutes' => $reminderMinutes,
        'due_timezone' => $dueTime !== '' ? $dueTimezone : '',
        'assignee' => is_string($task['assignee'] ?? null) ? $task['assignee'] : '',
        'tags' => array_values(array_filter($tags, 'is_string')),
        'text_format' => $normalizedTextFormat,
        'comments' => $normalizedComments,
        'deleted' => filter_var($task['deleted'] ?? false, FILTER_VALIDATE_BOOLEAN),
        'created_at' => is_string($task['created_at'] ?? null) ? $task['created_at'] : date('c'),
        'updated_at' => is_string($task['updated_at'] ?? null)
            ? $task['updated_at']
            : (is_string($task['created_at'] ?? null) ? $task['created_at'] : date('c')),
    ];

    if (
        is_string($task['completed_at'] ?? null)
        && strtotime($task['completed_at']) !== false
    ) {
        $normalized['completed_at'] = $task['completed_at'];
    }

    return $normalized;
}

function trimTaskText(string $value): string
{
    $trimmed = preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $value);
    if ($trimmed === null) {
        throw new InvalidArgumentException('Task text must contain valid UTF-8 characters.');
    }
    return $trimmed;
}

function readTextFormatDefaults(string $path, string $lockPath): array
{
    global $defaultTextFormats, $taskTextFormats;

    $lockHandle = fopen($lockPath, 'c+b');
    if ($lockHandle === false) {
        throw new RuntimeException('The task data lock file could not be opened.');
    }
    try {
        if (!flock($lockHandle, LOCK_SH)) {
            throw new RuntimeException('The task settings could not be locked for reading.');
        }
        if (!file_exists($path)) {
            return $defaultTextFormats;
        }
        $contents = file_get_contents($path);
        if ($contents === false) {
            throw new RuntimeException('The task formatting defaults could not be read.');
        }
        $settings = json_decode($contents, true);
        if (
            json_last_error() !== JSON_ERROR_NONE
            || !is_array($settings)
            || !is_array($settings['text_format_defaults'] ?? null)
        ) {
            throw new RuntimeException('The task formatting defaults file contains invalid JSON or settings.');
        }
        $defaults = $settings['text_format_defaults'];
        foreach (['title', 'description'] as $field) {
            if (!is_string($defaults[$field] ?? null) || !in_array($defaults[$field], $taskTextFormats, true)) {
                throw new RuntimeException('The task formatting defaults file contains invalid settings.');
            }
        }
        return [
            'title' => $defaults['title'],
            'description' => $defaults['description'],
        ];
    } finally {
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
    }
}

function saveTextFormatDefaults(string $path, string $lockPath, array $defaults): array
{
    global $defaultTextFormats, $taskTextFormats;

    $defaultFields = array_keys($defaults);
    sort($defaultFields);
    if ($defaultFields !== ['description', 'title']) {
        throw new InvalidArgumentException('Provide title and description formatting preferences.');
    }
    foreach (['title', 'description'] as $field) {
        if (!is_string($defaults[$field]) || !in_array($defaults[$field], $taskTextFormats, true)) {
            throw new InvalidArgumentException('Choose valid title and description formatting preferences.');
        }
    }

    $lockHandle = fopen($lockPath, 'c+b');
    if ($lockHandle === false) {
        throw new RuntimeException('The task data lock file could not be opened for writing.');
    }
    try {
        if (!flock($lockHandle, LOCK_EX)) {
            throw new RuntimeException('The task settings could not be locked for writing.');
        }
        $storedDefaults = [
            'title' => $defaults['title'],
            'description' => $defaults['description'],
        ];
        writeTasksAtomically($path, ['text_format_defaults' => $storedDefaults]);
        return $storedDefaults;
    } finally {
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
    }
}

function readTasksFromHandle($handle): array
{
    rewind($handle);
    $json = stream_get_contents($handle);
    if ($json === false) {
        throw new RuntimeException('The task data file could not be read.');
    }

    $tasks = json_decode($json, true);
    if (
        json_last_error() !== JSON_ERROR_NONE
        || !is_array($tasks)
        || array_values($tasks) !== $tasks
        || substr(ltrim($json), 0, 1) !== '['
    ) {
        throw new RuntimeException('The task data file contains invalid JSON.');
    }

    $normalizedTasks = [];
    $seenIds = [];
    foreach ($tasks as $task) {
        $normalizedTask = normalizeStoredTask($task);
        if (isset($seenIds[$normalizedTask['id']])) {
            throw new RuntimeException('The task data file contains duplicate task IDs.');
        }
        $seenIds[$normalizedTask['id']] = true;
        $normalizedTasks[] = $normalizedTask;
    }

    return $normalizedTasks;
}

function readTasks(string $path, string $lockPath): array
{
    $lockHandle = fopen($lockPath, 'c+b');
    if ($lockHandle === false) {
        throw new RuntimeException('The task data lock file could not be opened.');
    }

    $taskHandle = null;
    try {
        if (!flock($lockHandle, LOCK_SH)) {
            throw new RuntimeException('The task data file could not be locked for reading.');
        }
        $taskHandle = fopen($path, 'rb');
        if ($taskHandle === false) {
            throw new RuntimeException('The task data file could not be opened.');
        }
        if (!flock($taskHandle, LOCK_SH)) {
            throw new RuntimeException('The task data file could not be locked for reading.');
        }
        return readTasksFromHandle($taskHandle);
    } finally {
        if (is_resource($taskHandle)) {
            flock($taskHandle, LOCK_UN);
            fclose($taskHandle);
        }
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
    }
}

function validateTaskFields(array $input, ?array $existing = null): array
{
    global $taskStatuses, $taskPriorities, $taskAssignees, $taskTextFormats, $defaultTextFormats;

    $allowedFields = [
        'title',
        'description',
        'status',
        'priority',
        'due_date',
        'due_time',
        'reminder_minutes',
        'due_timezone',
        'assignee',
        'tags',
        'text_format',
    ];
    foreach (array_keys($input) as $field) {
        if (!in_array($field, $allowedFields, true)) {
            throw new InvalidArgumentException('Unsupported task field: ' . (string) $field);
        }
    }

    $values = array_merge([
        'title' => '',
        'description' => '',
        'status' => 'todo',
        'priority' => 'medium',
        'due_date' => '',
        'due_time' => '',
        'reminder_minutes' => null,
        'due_timezone' => '',
        'assignee' => '',
        'tags' => [],
        'text_format' => $defaultTextFormats,
    ], $existing ?? [], $input);

    if (!is_string($values['title'])) {
        throw new InvalidArgumentException('Task title must be text.');
    }
    $values['title'] = trimTaskText($values['title']);
    if ($values['title'] === '' || strlen($values['title']) > 160) {
        throw new InvalidArgumentException('Task title is required and must be 160 characters or fewer.');
    }

    if (!is_string($values['description'])) {
        throw new InvalidArgumentException('Task description must be text no longer than 5000 characters.');
    }
    $values['description'] = trimTaskText($values['description']);
    if (strlen($values['description']) > 5000) {
        throw new InvalidArgumentException('Task description must be text no longer than 5000 characters.');
    }
    if (!is_array($values['text_format'])) {
        throw new InvalidArgumentException('Choose valid title and description formatting.');
    }
    $formatFields = array_keys($values['text_format']);
    sort($formatFields);
    if ($formatFields !== ['description', 'title']) {
        throw new InvalidArgumentException('Choose valid title and description formatting.');
    }
    foreach (['title', 'description'] as $field) {
        if (!is_string($values['text_format'][$field] ?? null) || !in_array($values['text_format'][$field], $taskTextFormats, true)) {
            throw new InvalidArgumentException('Choose valid title and description formatting.');
        }
    }
    if (!is_string($values['status']) || !in_array($values['status'], $taskStatuses, true)) {
        throw new InvalidArgumentException('Choose a valid task status.');
    }
    if (!is_string($values['priority']) || !in_array($values['priority'], $taskPriorities, true)) {
        throw new InvalidArgumentException('Choose a valid task priority.');
    }

    if (!is_string($values['due_date'])) {
        throw new InvalidArgumentException('Due date must be text.');
    }
    if ($values['due_date'] !== '') {
        $dateParts = [];
        if (
            !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $values['due_date'], $dateParts)
            || !checkdate((int) $dateParts[2], (int) $dateParts[3], (int) $dateParts[1])
        ) {
            throw new InvalidArgumentException('Due date must be a valid YYYY-MM-DD date.');
        }
    }
    if (!is_string($values['due_time'])) {
        throw new InvalidArgumentException('Due time must be text.');
    }
    if ($values['due_time'] !== '' && !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $values['due_time'])) {
        throw new InvalidArgumentException('Due time must be a valid local time.');
    }
    if (!is_string($values['due_timezone'])) {
        throw new InvalidArgumentException('Due-time timezone must be text.');
    }
    if ($values['due_timezone'] !== '') {
        try {
            $dueTimezone = new DateTimeZone($values['due_timezone']);
        } catch (Throwable $error) {
            throw new InvalidArgumentException('Choose a valid local timezone for the due time.');
        }
    }
    if ($values['due_time'] !== '' && ($values['due_date'] === '' || $values['due_timezone'] === '')) {
        throw new InvalidArgumentException('A due time requires a due date and local timezone.');
    }
    if ($values['due_time'] === '') {
        $values['due_timezone'] = '';
    }
    if (
        $values['reminder_minutes'] !== null
        && $values['reminder_minutes'] !== 5
        && $values['reminder_minutes'] !== 10
    ) {
        throw new InvalidArgumentException('Choose a reminder interval of 5 or 10 minutes.');
    }
    if ($values['reminder_minutes'] !== null) {
        if ($values['due_date'] === '' || $values['due_time'] === '' || $values['due_timezone'] === '') {
            throw new InvalidArgumentException('A reminder requires both a due date and due time.');
        }
        $deadline = DateTimeImmutable::createFromFormat(
            '!Y-m-d H:i',
            $values['due_date'] . ' ' . $values['due_time'],
            $dueTimezone
        );
        $dateErrors = DateTimeImmutable::getLastErrors();
        if (
            $deadline === false
            || ($dateErrors !== false && ($dateErrors['warning_count'] > 0 || $dateErrors['error_count'] > 0))
        ) {
            throw new InvalidArgumentException('The due date and time are not valid in the selected timezone.');
        }
        if ($deadline <= new DateTimeImmutable('now', $dueTimezone)) {
            throw new InvalidArgumentException('A reminder cannot be set for a deadline in the past.');
        }
    }

    if (!is_string($values['assignee']) || ($values['assignee'] !== '' && !in_array($values['assignee'], $taskAssignees, true))) {
        throw new InvalidArgumentException('Choose an assignee from the available list.');
    }

    if (!is_array($values['tags']) || count($values['tags']) > 20) {
        throw new InvalidArgumentException('Tags must be a list of no more than 20 names.');
    }
    $tags = [];
    foreach ($values['tags'] as $tag) {
        if (!is_string($tag) || trim($tag) === '' || strlen(trim($tag)) > 40) {
            throw new InvalidArgumentException('Each tag must contain 1 to 40 characters.');
        }
        $tag = trim($tag);
        if (!in_array($tag, $tags, true)) {
            $tags[] = $tag;
        }
    }
    $values['tags'] = $tags;

    return $values;
}

function writeTasksToHandle($handle, array $tasks): void
{
    $json = json_encode(
        $tasks,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );
    if ($json === false) {
        throw new RuntimeException('Tasks could not be encoded as JSON.');
    }

    if (!ftruncate($handle, 0) || !rewind($handle)) {
        throw new RuntimeException('The task data file could not be prepared for writing.');
    }
    $contents = $json . PHP_EOL;
    $written = 0;
    $length = strlen($contents);
    while ($written < $length) {
        $count = fwrite($handle, substr($contents, $written));
        if ($count === false || $count === 0) {
            throw new RuntimeException('The task data file could not be written.');
        }
        $written += $count;
    }
    if (!fflush($handle)) {
        throw new RuntimeException('The task data file could not be flushed to disk.');
    }
}

function writeTasksAtomically(string $path, array $tasks): void
{
    $json = json_encode(
        $tasks,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );
    if ($json === false) {
        throw new RuntimeException('Tasks could not be encoded as JSON.');
    }

    $temporaryPath = tempnam(dirname($path), '.tasks-');
    if ($temporaryPath === false) {
        throw new RuntimeException('A temporary task data file could not be created.');
    }

    $temporaryHandle = fopen($temporaryPath, 'wb');
    if ($temporaryHandle === false) {
        @unlink($temporaryPath);
        throw new RuntimeException('The temporary task data file could not be opened.');
    }

    try {
        $contents = $json . PHP_EOL;
        $written = 0;
        $length = strlen($contents);
        while ($written < $length) {
            $count = fwrite($temporaryHandle, substr($contents, $written));
            if ($count === false || $count === 0) {
                throw new RuntimeException('The temporary task data file could not be written.');
            }
            $written += $count;
        }
        if (!fflush($temporaryHandle)) {
            throw new RuntimeException('The temporary task data file could not be flushed.');
        }
        if (function_exists('fsync') && !fsync($temporaryHandle)) {
            throw new RuntimeException('The temporary task data file could not be synchronized.');
        }
    } catch (Throwable $error) {
        fclose($temporaryHandle);
        @unlink($temporaryPath);
        throw $error;
    }
    fclose($temporaryHandle);

    if (!rename($temporaryPath, $path)) {
        @unlink($temporaryPath);
        throw new RuntimeException('The task data file could not be replaced atomically.');
    }
}

function preserveLegacyCompletionTimestamp(array &$task): void
{
    if (
        ($task['status'] ?? null) === 'done'
        && !isset($task['completed_at'])
        && is_string($task['updated_at'] ?? null)
        && strtotime($task['updated_at']) !== false
    ) {
        $task['completed_at'] = $task['updated_at'];
    }
}

function textCharacterCount(string $value): int
{
    $count = preg_match_all('/./us', $value);
    if ($count === false) {
        throw new InvalidArgumentException('Text must contain valid UTF-8 characters.');
    }
    return $count;
}

function trimCommentText(string $value): string
{
    $trimmed = preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $value);
    if ($trimmed === null) {
        throw new InvalidArgumentException('Comment text must contain valid UTF-8 characters.');
    }
    return $trimmed;
}

function mutateTasks(string $path, string $lockPath, string $action, array $payload): array
{
    global $taskStatuses;

    $lockHandle = fopen($lockPath, 'c+b');
    if ($lockHandle === false) {
        throw new RuntimeException('The task data lock file could not be opened for writing.');
    }

    $taskHandle = null;
    try {
        if (!flock($lockHandle, LOCK_EX)) {
            throw new RuntimeException('The task data file could not be locked for writing.');
        }
        $taskHandle = fopen($path, 'c+b');
        if ($taskHandle === false) {
            throw new RuntimeException('The task data file could not be opened for writing.');
        }
        if (!flock($taskHandle, LOCK_EX)) {
            throw new RuntimeException('The task data file could not be locked for writing.');
        }
        $tasks = readTasksFromHandle($taskHandle);
        $taskPayload = $payload['task'] ?? null;
        $taskId = $payload['id'] ?? (is_array($taskPayload) ? ($taskPayload['id'] ?? null) : null);
        if (
            !in_array($action, ['create', 'bulk_soft_delete', 'clear_trash'], true)
            && (
                !is_string($taskId)
                || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/', $taskId)
            )
        ) {
            throw new InvalidArgumentException('A valid task ID is required.');
        }
        if (
            $action === 'create'
            && (
                isset($payload['id'])
                || (is_array($payload['task'] ?? null) && isset($payload['task']['id']))
            )
        ) {
            throw new InvalidArgumentException('Task IDs are generated by the server.');
        }

        $taskIndex = null;
        if (!in_array($action, ['create', 'bulk_soft_delete', 'clear_trash'], true)) {
            foreach ($tasks as $index => $task) {
                if ($task['id'] === $taskId) {
                    $taskIndex = $index;
                    break;
                }
            }
            if ($taskIndex === null) {
                throw new TaskNotFoundException('The requested task was not found.');
            }
        }

        $resultTask = null;
        switch ($action) {
            case 'create':
                if (!isset($payload['task']) || !is_array($payload['task'])) {
                    throw new InvalidArgumentException('Task data is required to create a task.');
                }
                $fields = validateTaskFields($payload['task']);
                $now = date('c');
                $resultTask = array_merge($fields, [
                    'id' => 'task-' . bin2hex(random_bytes(8)),
                    'deleted' => false,
                    'comments' => [],
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
                if ($fields['status'] === 'done') {
                    $resultTask['completed_at'] = $now;
                }
                $tasks[] = $resultTask;
                break;

            case 'update':
                if (!isset($payload['task']) || !is_array($payload['task'])) {
                    throw new InvalidArgumentException('Task data is required to update a task.');
                }
                if ($tasks[$taskIndex]['deleted']) {
                    throw new InvalidArgumentException('Restore a task before editing it.');
                }
                if (isset($payload['task']['id']) && $payload['task']['id'] !== $taskId) {
                    throw new InvalidArgumentException('Task ID cannot be changed.');
                }
                $existing = $tasks[$taskIndex];
                $taskInput = $payload['task'];
                unset($taskInput['id']);
                $existingFields = array_intersect_key($existing, array_flip([
                    'title',
                    'description',
                    'status',
                    'priority',
                    'due_date',
                    'due_time',
                    'reminder_minutes',
                    'due_timezone',
                    'assignee',
                    'tags',
                    'text_format',
                ]));
                $fields = validateTaskFields($taskInput, $existingFields);
                $resultTask = array_merge($existing, $fields);
                if ($fields['status'] === 'done') {
                    if ($existing['status'] !== 'done') {
                        $resultTask['completed_at'] = date('c');
                    } else {
                        preserveLegacyCompletionTimestamp($resultTask);
                    }
                } else {
                    unset($resultTask['completed_at']);
                }
                $resultTask['updated_at'] = date('c');
                $tasks[$taskIndex] = $resultTask;
                break;

            case 'add_comment':
                if ($tasks[$taskIndex]['deleted']) {
                    throw new InvalidArgumentException('Restore a task before adding comments.');
                }
                if (!is_string($payload['message'] ?? null)) {
                    throw new InvalidArgumentException('Comment text is required.');
                }
                $message = trimCommentText($payload['message']);
                $messageLength = textCharacterCount($message);
                if ($message === '') {
                    throw new InvalidArgumentException('Enter a comment before submitting.');
                }
                if ($messageLength > 5000) {
                    throw new InvalidArgumentException('Comments must be 5000 characters or fewer.');
                }
                preserveLegacyCompletionTimestamp($tasks[$taskIndex]);
                do {
                    $commentId = 'comment-' . bin2hex(random_bytes(12));
                    $idInUse = false;
                    foreach ($tasks as $storedTask) {
                        foreach ($storedTask['comments'] as $storedComment) {
                            if ($storedComment['id'] === $commentId) {
                                $idInUse = true;
                                break 2;
                            }
                        }
                    }
                } while ($idInUse);
                $tasks[$taskIndex]['comments'][] = [
                    'id' => $commentId,
                    'author' => 'Deepak Rajoriya',
                    'message' => $message,
                    'created_at' => date('c'),
                ];
                $tasks[$taskIndex]['updated_at'] = date('c');
                $resultTask = $tasks[$taskIndex];
                break;

            case 'soft_delete':
                preserveLegacyCompletionTimestamp($tasks[$taskIndex]);
                $tasks[$taskIndex]['deleted'] = true;
                $tasks[$taskIndex]['updated_at'] = date('c');
                $resultTask = $tasks[$taskIndex];
                break;

            case 'restore':
                if (!$tasks[$taskIndex]['deleted']) {
                    throw new InvalidArgumentException('Only trashed tasks can be restored.');
                }
                preserveLegacyCompletionTimestamp($tasks[$taskIndex]);
                $tasks[$taskIndex]['deleted'] = false;
                $tasks[$taskIndex]['updated_at'] = date('c');
                $resultTask = $tasks[$taskIndex];
                break;

            case 'bulk_soft_delete':
                $taskIds = $payload['taskIds'] ?? null;
                if (
                    !is_array($taskIds)
                    || array_values($taskIds) !== $taskIds
                    || count($taskIds) < 1
                    || count($taskIds) > 100
                ) {
                    throw new InvalidArgumentException('Select between 1 and 100 tasks for bulk deletion.');
                }

                $seenIds = [];
                foreach ($taskIds as $selectedId) {
                    if (
                        !is_string($selectedId)
                        || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/', $selectedId)
                    ) {
                        throw new InvalidArgumentException('Every selected task ID must be valid.');
                    }
                    if (isset($seenIds[$selectedId])) {
                        throw new InvalidArgumentException('Duplicate task IDs are not allowed.');
                    }
                    $seenIds[$selectedId] = true;
                }

                $deletedTasks = [];
                $rejectedIds = [];
                $now = date('c');
                foreach ($taskIds as $selectedId) {
                    $selectedIndex = null;
                    foreach ($tasks as $index => $task) {
                        if ($task['id'] === $selectedId) {
                            $selectedIndex = $index;
                            break;
                        }
                    }
                    if ($selectedIndex === null || $tasks[$selectedIndex]['deleted']) {
                        $rejectedIds[] = $selectedId;
                        continue;
                    }
                    preserveLegacyCompletionTimestamp($tasks[$selectedIndex]);
                    $tasks[$selectedIndex]['deleted'] = true;
                    $tasks[$selectedIndex]['updated_at'] = $now;
                    $deletedTasks[] = $tasks[$selectedIndex];
                }
                $resultTask = null;
                break;

            case 'permanent_delete':
                if (!$tasks[$taskIndex]['deleted']) {
                    throw new InvalidArgumentException('Move a task to Trash before permanently deleting it.');
                }
                $resultTask = $tasks[$taskIndex];
                array_splice($tasks, $taskIndex, 1);
                break;

            case 'clear_trash':
                $removedIds = [];
                $remainingTasks = [];
                foreach ($tasks as $task) {
                    if ($task['deleted']) {
                        $removedIds[] = $task['id'];
                    } else {
                        $remainingTasks[] = $task;
                    }
                }
                $tasks = $remainingTasks;
                $resultTask = null;
                break;

            default:
                throw new InvalidArgumentException('Unsupported task action.');
        }

        flock($taskHandle, LOCK_UN);
        fclose($taskHandle);
        $taskHandle = null;
        writeTasksAtomically($path, $tasks);
        if ($action === 'bulk_soft_delete') {
            return [
                'task' => null,
                'tasks' => $tasks,
                'deleted_tasks' => $deletedTasks,
                'deleted_count' => count($deletedTasks),
                'rejected_ids' => $rejectedIds,
            ];
        }
        if ($action === 'clear_trash') {
            return [
                'task' => null,
                'tasks' => $tasks,
                'removed_ids' => $removedIds,
                'removed_count' => count($removedIds),
            ];
        }
        return ['task' => $resultTask, 'tasks' => $tasks];
    } finally {
        if (is_resource($taskHandle)) {
            flock($taskHandle, LOCK_UN);
            fclose($taskHandle);
        }
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
    }
}

function statusLabel(string $status): string
{
    $labels = [
        'todo' => 'To Do',
        'in_progress' => 'In Progress',
        'review' => 'Review',
        'done' => 'Done',
    ];

    return $labels[$status] ?? 'To Do';
}

$isApiRequest = isset($_GET['ajax']) && $_GET['ajax'] === '1';

try {
    ensureTaskStore($dataDirectory, $tasksFile, $tasksLockFile);
    $defaultTextFormats = readTextFormatDefaults($settingsFile, $tasksLockFile);

    if ($isApiRequest) {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if ($method === 'GET') {
            $action = $_GET['action'] ?? 'list';
            if ($action === 'settings') {
                sendJsonResponse(
                    200,
                    true,
                    ['text_format_defaults' => readTextFormatDefaults($settingsFile, $tasksLockFile)],
                    'Task settings loaded.'
                );
            }
            if (!in_array($action, ['list', 'trash'], true)) {
                sendJsonResponse(400, false, null, 'Unsupported task action.');
            }
            $tasks = readTasks($tasksFile, $tasksLockFile);
            $isDeleted = $action === 'trash';
            $selectedTasks = array_values(array_filter($tasks, static function ($task) use ($isDeleted): bool {
                return $task['deleted'] === $isDeleted;
            }));
            sendJsonResponse(200, true, ['tasks' => $selectedTasks], $isDeleted ? 'Trash loaded.' : 'Tasks loaded.');
        }

        if ($method === 'POST') {
            $contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
            if ($contentType !== 'application/json') {
                sendJsonResponse(415, false, null, 'Content-Type must be application/json.');
            }
            $requestToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
            if (
                !is_string($requestToken)
                || !hash_equals($csrfToken, $requestToken)
            ) {
                sendJsonResponse(403, false, null, 'The request could not be verified. Refresh the page and try again.');
            }
            $requestBody = file_get_contents('php://input');
            if ($requestBody === false || trim($requestBody) === '') {
                sendJsonResponse(400, false, null, 'A JSON request body is required.');
            }
            $requestObject = json_decode($requestBody);
            $payload = json_decode($requestBody, true);
            if (
                json_last_error() !== JSON_ERROR_NONE
                || !is_array($payload)
                || !is_object($requestObject)
                || substr(ltrim($requestBody), 0, 1) !== '{'
            ) {
                sendJsonResponse(400, false, null, 'Request body must be a JSON object.');
            }
            foreach (array_keys($payload) as $field) {
                if (!in_array($field, ['action', 'id', 'task', 'taskIds', 'message', 'defaults'], true)) {
                    sendJsonResponse(400, false, null, 'Unsupported request field: ' . (string) $field);
                }
            }
            $action = $payload['action'] ?? '';
            $allowedActions = [
                'create',
                'update',
                'add_comment',
                'soft_delete',
                'restore',
                'permanent_delete',
                'bulk_soft_delete',
                'clear_trash',
                'save_text_format_defaults',
            ];
            if (!is_string($action) || !in_array($action, $allowedActions, true)) {
                sendJsonResponse(400, false, null, 'Unsupported task action.');
            }
            $envelopeFields = array_keys($payload);
            sort($envelopeFields);
            if ($action === 'create') {
                if (
                    $envelopeFields !== ['action', 'task']
                    || !isset($requestObject->task)
                    || !is_object($requestObject->task)
                ) {
                    sendJsonResponse(400, false, null, 'Create requires a task object and no task ID.');
                }
            } elseif ($action === 'update') {
                if (
                    !in_array($envelopeFields, [['action', 'task'], ['action', 'id', 'task']], true)
                    || !isset($requestObject->task)
                    || !is_object($requestObject->task)
                ) {
                    sendJsonResponse(400, false, null, 'Update requires a task object and an optional task ID.');
                }
            } elseif ($action === 'bulk_soft_delete') {
                if (
                    $envelopeFields !== ['action', 'taskIds']
                    || !isset($requestObject->taskIds)
                    || !is_array($requestObject->taskIds)
                ) {
                    sendJsonResponse(400, false, null, 'Bulk deletion requires a taskIds array.');
                }
            } elseif ($action === 'add_comment') {
                if (
                    $envelopeFields !== ['action', 'id', 'message']
                    || !is_string($requestObject->id ?? null)
                    || !is_string($requestObject->message ?? null)
                ) {
                    sendJsonResponse(400, false, null, 'Adding a comment requires a task ID and comment text.');
                }
            } elseif ($action === 'clear_trash') {
                if ($envelopeFields !== ['action']) {
                    sendJsonResponse(400, false, null, 'Clearing Trash requires only the action.');
                }
            } elseif ($action === 'save_text_format_defaults') {
                if (
                    $envelopeFields !== ['action', 'defaults']
                    || !isset($requestObject->defaults)
                    || !is_object($requestObject->defaults)
                ) {
                    sendJsonResponse(400, false, null, 'Saving formatting defaults requires a preferences object.');
                }
            } elseif ($envelopeFields !== ['action', 'id']) {
                sendJsonResponse(400, false, null, 'This task action requires only an action and task ID.');
            }
            if (
                isset($requestObject->task)
                && property_exists($requestObject->task, 'tags')
                && !is_array($requestObject->task->tags)
            ) {
                sendJsonResponse(400, false, null, 'Tags must be provided as a JSON array.');
            }
            if ($action === 'save_text_format_defaults') {
                $defaults = saveTextFormatDefaults(
                    $settingsFile,
                    $tasksLockFile,
                    $payload['defaults']
                );
                sendJsonResponse(200, true, ['text_format_defaults' => $defaults], 'Formatting defaults saved.');
            }
            $result = mutateTasks($tasksFile, $tasksLockFile, $action, $payload);
            sendJsonResponse(200, true, $result, 'Task operation completed.');
        }

        header('Allow: GET, POST');
        sendJsonResponse(405, false, null, 'Method not allowed.');
    }

    $tasks = readTasks($tasksFile, $tasksLockFile);
} catch (TaskNotFoundException $error) {
    if (isset($isApiRequest) && $isApiRequest) {
        sendJsonResponse(404, false, null, $error->getMessage());
    }
    error_log($error->getMessage());
    http_response_code(500);
    exit('Unable to load task data.');
} catch (InvalidArgumentException $error) {
    if (isset($isApiRequest) && $isApiRequest) {
        sendJsonResponse(400, false, null, $error->getMessage());
    }
    error_log($error->getMessage());
    http_response_code(500);
    exit('Unable to load task data.');
} catch (Throwable $error) {
    if (isset($isApiRequest) && $isApiRequest) {
        error_log($error->getMessage());
        sendJsonResponse(500, false, null, 'Task storage is currently unavailable. Please try again.');
    }
    error_log($error->getMessage());
    http_response_code(500);
    exit('Unable to load task data.');
}

$activeTasks = array_values(array_filter($tasks, static function ($task): bool {
    return is_array($task) && empty($task['deleted']);
}));
$textFormatDefaults = readTextFormatDefaults($settingsFile, $tasksLockFile);
$emptyTask = [
    'id' => '',
    'title' => '',
    'description' => '',
    'status' => 'todo',
    'priority' => 'medium',
    'assignee' => '',
    'due_date' => '',
    'tags' => [],
];
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#ffffff">
    <meta name="csrf-token" content="<?= escapeHtml($csrfToken) ?>">
    <title>Deepak Rajoriya — Task Manager</title>
    <link rel="icon" href="assets/images/favicon.ico" type="image/x-icon" sizes="48x48">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        window.tailwind.config = {
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
                    }
                }
            }
        };
    </script>
    <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js"></script>
    <link rel="stylesheet" href="assets/css/style.css">
</head>

<body class="min-h-screen bg-white font-sans text-slate-900 antialiased">
    <div id="app" class="min-h-screen">
        <div class="flex min-h-screen">
            <div class="flex min-w-0 flex-1 flex-col">
                <header class="dashboard-header sticky top-0 z-30">
                    <div class="dashboard-header-inner">
                        <a href="index.php" class="brand-lockup text-slate-950 no-underline">
                            <span class="brand-mark" aria-hidden="true">
                                <img src="assets/images/logo.png" alt="" width="34" height="34">
                            </span>
                            <span class="brand-copy">
                                <span class="app-title">Deepak Rajoriya</span>
                                <span class="brand-subtitle">Task Manager</span>
                            </span>
                        </a>

                        <span class="header-divider" aria-hidden="true"></span>
                        <div class="header-clock-wrap">
                            <i data-lucide="calendar-days" class="header-clock-icon" aria-hidden="true"></i>
                            <div id="live-clock" class="live-clock" aria-label="Current local date and time" aria-live="off">
                                <time id="live-date" class="block"></time>
                                <time id="live-time" class="block"></time>
                            </div>
                        </div>

                        <div class="header-search header-search-desktop relative hidden md:block">
                            <i data-lucide="search" class="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400"></i>
                            <input
                                id="task-search"
                                type="search"
                                placeholder="Search tasks, tags or keywords..."
                                autocomplete="off"
                                aria-label="Search tasks, tags or keywords"
                                class="h-11 w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-11 pr-11 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-slate-300 focus:bg-white focus:ring-4 focus:ring-slate-100"
                            >
                            <button id="clear-search" type="button" aria-label="Clear search" class="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                                <i data-lucide="x" class="h-4 w-4"></i>
                            </button>
                        </div>

                        <div class="dashboard-header-actions">
                            <label class="priority-filter-control header-filter-control flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                                <i data-lucide="list-filter" class="header-action-icon h-4 w-4" aria-hidden="true"></i>
                                <span id="priority-filter-indicator" class="priority-filter-indicator" data-priority="all" aria-hidden="true"></span>
                                <span class="sr-only">Filter tasks by priority</span>
                                <select id="priority-filter" aria-label="Filter tasks by priority" class="min-w-0 bg-transparent font-medium text-slate-700 outline-none">
                                    <option value="all">All priorities</option>
                                    <option value="high">High</option>
                                    <option value="medium">Medium</option>
                                    <option value="low">Low</option>
                                </select>
                            </label>
                            <button id="completed-history-button" type="button" class="header-action-button">
                                <i data-lucide="history" class="h-4 w-4" aria-hidden="true"></i>
                                <span>Completed History</span>
                            </button>
                            <button id="open-trash" type="button" aria-label="Open Trash" class="header-action-button header-trash-button">
                                <i data-lucide="trash-2" class="h-4 w-4" aria-hidden="true"></i>
                                <span>Trash</span>
                            </button>
                            <button id="add-task" type="button" aria-label="Add a task" class="header-add-button">
                                <i data-lucide="plus" class="h-[18px] w-[18px]" aria-hidden="true"></i>
                                <span>Add Task</span>
                            </button>
                        </div>

                        <div class="header-search-mobile px-5 pb-3 md:hidden">
                            <div class="relative">
                                <i data-lucide="search" class="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"></i>
                                <input id="task-search-mobile" type="search" placeholder="Search tasks, tags or keywords..." autocomplete="off" aria-label="Search tasks" class="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-4 text-sm outline-none focus:border-slate-300 focus:bg-white">
                            </div>
                        </div>
                    </div>
                </header>

                <main class="flex-1 px-5 py-7 lg:px-8">
                    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <h1 class="page-heading text-2xl font-bold tracking-tight text-slate-950">Workspace</h1>
                            <p class="mt-1.5 text-sm text-slate-500">A clear view of what’s moving and what’s next.</p>
                        </div>
                        <div id="board-summary" class="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500 shadow-sm">
                            <span id="total-tasks"><?= count($activeTasks) ?></span> board tasks
                            <span id="filtered-task-summary" class="hidden ml-1 text-slate-400">(<span id="visible-task-count"><?= count($activeTasks) ?></span> shown)</span>
                            <span id="overdue-summary" class="hidden ml-2 font-semibold text-red-700"></span>
                        </div>
                    </div>

                    <div id="bulk-actions-toolbar" class="bulk-actions-toolbar mb-5 hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm" role="region" aria-label="Selected task actions">
                        <strong class="text-sm font-semibold text-slate-700"><span id="selected-task-count">0</span> selected</strong>
                        <button id="toggle-select-all" type="button" class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100">Select all</button>
                        <button id="bulk-delete-selected" type="button" class="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100">
                            <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
                            Delete selected
                        </button>
                        <button id="clear-task-selection" type="button" class="ml-auto rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800">Clear</button>
                    </div>

                    <?php
                    $statusStyles = [
                        'todo' => ['panel' => 'border-slate-200 bg-slate-50/90', 'badge' => 'bg-white text-slate-600'],
                        'in_progress' => ['panel' => 'border-blue-100 bg-blue-50/70', 'badge' => 'bg-white text-blue-700'],
                        'review' => ['panel' => 'border-amber-100 bg-amber-50/70', 'badge' => 'bg-white text-amber-700'],
                        'done' => ['panel' => 'border-emerald-100 bg-emerald-50/70', 'badge' => 'bg-white text-emerald-700'],
                    ];
                    ?>
                    <section id="kanban-board" aria-label="Kanban task board" aria-busy="true" class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <?php foreach ($taskStatuses as $status): $style = $statusStyles[$status]; ?>
                            <section class="kanban-column min-w-0 rounded-2xl border p-3.5 sm:p-4 <?= $style['panel'] ?>" data-status="<?= escapeHtml($status) ?>">
                                <div class="kanban-column-heading mb-4 flex items-center justify-between">
                                    <div class="flex min-w-0 items-center gap-2.5">
                                        <?php
                                        $statusIcons = [
                                            'todo' => 'circle-dot',
                                            'in_progress' => 'folder-kanban',
                                            'review' => 'panel-top',
                                            'done' => 'square-check',
                                        ];
                                        ?>
                                        <span class="column-status-icon column-status-<?= escapeHtml($status) ?>" aria-hidden="true">
                                            <i data-lucide="<?= escapeHtml($statusIcons[$status]) ?>" class="h-[18px] w-[18px]"></i>
                                        </span>
                                        <h2 class="truncate text-sm font-bold text-slate-800"><?= escapeHtml(statusLabel($status)) ?></h2>
                                        <span class="task-count rounded-full px-2 py-0.5 text-[11px] font-semibold <?= $style['badge'] ?>">0</span>
                                    </div>
                                    <button type="button" class="column-menu-button column-menu-trigger flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-slate-500 shadow-sm ring-1 ring-black/5 transition hover:text-slate-950" data-status="<?= escapeHtml($status) ?>" aria-label="Column actions for <?= escapeHtml(statusLabel($status)) ?>" aria-haspopup="menu" aria-expanded="false">
                                        <i data-lucide="ellipsis" class="h-4 w-4"></i>
                                    </button>
                                </div>
                                <div class="column-options-menu hidden" role="menu">
                                    <button type="button" class="quick-add column-menu-add" data-status="<?= escapeHtml($status) ?>" role="menuitem">
                                        <i data-lucide="plus" class="h-4 w-4" aria-hidden="true"></i>
                                        Add task
                                    </button>
                                </div>
                                <div class="task-list min-h-24" data-status="<?= escapeHtml($status) ?>"></div>
                                <button type="button" class="column-add-task quick-add mt-3 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-500 transition hover:bg-white hover:text-slate-900" data-status="<?= escapeHtml($status) ?>" aria-label="Add task to <?= escapeHtml(statusLabel($status)) ?>">
                                    <i data-lucide="plus" class="h-4 w-4"></i>
                                    Add task
                                </button>
                            </section>
                        <?php endforeach; ?>
                    </section>

                    <div id="search-empty-state" class="hidden py-20 text-center">
                        <span class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
                            <i data-lucide="search-x" class="h-6 w-6"></i>
                        </span>
                        <h2 class="text-sm font-semibold">No results found</h2>
                        <p class="mt-1 text-sm text-slate-500">Try another search term.</p>
                    </div>
                </main>
            </div>

            <div id="drawer-overlay" class="fixed inset-0 z-40 hidden bg-slate-950/30 backdrop-blur-[2px]" aria-hidden="true"></div>

            <aside id="task-drawer" class="task-drawer is-closed fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col border-l border-slate-200 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-hidden="true" inert tabindex="-1">
                <div class="flex items-start justify-between border-b border-slate-100 px-6 pb-4 pt-6">
                    <div>
                        <p class="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Task workspace</p>
                        <h2 id="drawer-title" class="text-xl font-bold tracking-tight text-slate-950">Task Details</h2>
                    </div>
                    <button id="close-drawer" type="button" aria-label="Close task details" class="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-800">
                        <i data-lucide="x" class="h-5 w-5"></i>
                    </button>
                </div>

                <nav class="task-drawer-tabs flex gap-6 border-b border-slate-100 px-6" role="tablist" aria-label="Task details and comments">
                    <button id="task-details-tab" type="button" class="drawer-tab is-active" role="tab" aria-selected="true" aria-controls="drawer-content" tabindex="0">Details</button>
                    <button id="task-comments-tab" type="button" class="drawer-tab" role="tab" aria-selected="false" aria-controls="drawer-content" aria-label="Comments, 0 comments" tabindex="-1" disabled>Comments <span id="comment-count" class="comment-count">0</span></button>
                </nav>

                <div id="drawer-content" class="flex-1 overflow-y-auto px-6 py-5">
                    <form id="task-form" class="space-y-4">
                        <input id="task-id" name="id" type="hidden" value="<?= escapeHtml($emptyTask['id']) ?>">
                        <div class="block">
                            <span class="field-label-row mb-1.5 flex items-center justify-between gap-2">
                                <label for="task-title" class="text-xs font-semibold text-slate-700">Title <span class="text-red-500">*</span></label>
                                <span class="text-format-controls" role="group" aria-label="Title display formatting">
                                    <button type="button" class="text-format-button" data-format-field="title" data-format-mode="uppercase" title="Uppercase" aria-label="Display title in uppercase">AA</button>
                                    <button type="button" class="text-format-button" data-format-field="title" data-format-mode="capital_case" title="Capital Case" aria-label="Display title in capital case">Aa</button>
                                    <button type="button" class="text-format-button" data-format-field="title" data-format-mode="sentence_case" title="Sentence Case" aria-label="Display title in sentence case">Aa.</button>
                                </span>
                            </span>
                            <input id="task-title" name="title" type="text" required value="<?= escapeHtml($emptyTask['title']) ?>" placeholder="Give your task a title" class="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-100">
                            <p id="task-title-preview" class="text-format-preview" aria-live="polite"></p>
                        </div>

                        <div class="block">
                            <span class="field-label-row mb-1.5 flex items-center justify-between gap-2">
                                <label for="task-description" class="text-xs font-semibold text-slate-700">Description</label>
                                <span class="text-format-controls" role="group" aria-label="Description display formatting">
                                    <button type="button" class="text-format-button" data-format-field="description" data-format-mode="uppercase" title="Uppercase" aria-label="Display description in uppercase">AA</button>
                                    <button type="button" class="text-format-button" data-format-field="description" data-format-mode="capital_case" title="Capital Case" aria-label="Display description in capital case">Aa</button>
                                    <button type="button" class="text-format-button" data-format-field="description" data-format-mode="sentence_case" title="Sentence Case" aria-label="Display description in sentence case">Aa.</button>
                                </span>
                            </span>
                            <textarea id="task-description" name="description" rows="3" placeholder="Add a few details about this task..." class="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-5 text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-100"><?= escapeHtml($emptyTask['description']) ?></textarea>
                            <p id="task-description-preview" class="text-format-preview whitespace-pre-wrap" aria-live="polite"></p>
                        </div>
                        <p class="format-preference-help">In Add Task, these choices become defaults for future tasks. In Edit, they affect only this task.</p>

                        <div class="grid grid-cols-2 gap-3">
                            <label class="block">
                                <span class="mb-1.5 block text-xs font-semibold text-slate-700">Status <span class="text-red-500">*</span></span>
                                <span class="relative block">
                                    <select id="task-status" name="status" aria-label="Status" required class="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pr-8 text-xs font-medium text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100">
                                        <?php foreach ($taskStatuses as $status): ?>
                                            <option value="<?= escapeHtml($status) ?>" <?= $status === $emptyTask['status'] ? 'selected' : '' ?>><?= escapeHtml(statusLabel($status)) ?></option>
                                        <?php endforeach; ?>
                                    </select>
                                </span>
                            </label>
                            <label class="block">
                                <span class="mb-1.5 block text-xs font-semibold text-slate-700">Priority <span class="text-red-500">*</span></span>
                                <span class="relative block">
                                    <select id="task-priority" name="priority" aria-label="Priority" required class="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pr-8 text-xs font-medium text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100">
                                        <?php foreach (['high' => 'High', 'medium' => 'Medium', 'low' => 'Low'] as $value => $label): ?>
                                            <option value="<?= escapeHtml($value) ?>" <?= $emptyTask['priority'] === $value ? 'selected' : '' ?>><?= escapeHtml($label) ?></option>
                                        <?php endforeach; ?>
                                    </select>
                                </span>
                            </label>
                        </div>

                        <label class="block">
                            <span class="mb-1.5 block text-xs font-semibold text-slate-700">Assignee</span>
                            <span class="relative block">
                                <select id="task-assignee" name="assignee" aria-label="Assignee" class="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pr-8 text-sm text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100">
                                    <option value="">Unassigned</option>
                                    <?php foreach ($taskAssignees as $assignee): ?>
                                        <option value="<?= escapeHtml($assignee) ?>"><?= escapeHtml($assignee) ?></option>
                                    <?php endforeach; ?>
                                </select>
                            </span>
                        </label>

                        <div class="grid grid-cols-2 gap-3">
                            <label class="block">
                                <span class="mb-1.5 block text-xs font-semibold text-slate-700">Due Date</span>
                                <span class="relative block">
                                    <i data-lucide="calendar-days" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"></i>
                                    <input id="task-due-date" name="due_date" type="date" value="<?= escapeHtml($emptyTask['due_date']) ?>" class="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-9 text-sm text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100">
                                    <button id="clear-due-date" type="button" aria-label="Clear due date" class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                                        <i data-lucide="x" class="h-3.5 w-3.5"></i>
                                    </button>
                                </span>
                            </label>
                            <label class="block">
                                <span class="mb-1.5 block text-xs font-semibold text-slate-700">Due Time <span class="font-normal text-slate-400">Optional</span></span>
                                <input id="task-due-time" name="due_time" type="time" class="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100">
                            </label>
                        </div>
                        <label class="block">
                            <span class="mb-1.5 block text-xs font-semibold text-slate-700">Reminder <span class="font-normal text-slate-400">Optional</span></span>
                            <select id="task-reminder-minutes" name="reminder_minutes" aria-label="Reminder interval" class="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100" disabled>
                                <option value="">No reminder</option>
                                <option value="5">5 minutes before</option>
                                <option value="10">10 minutes before</option>
                            </select>
                            <p id="reminder-local-time-notice" class="mt-1 hidden text-xs text-slate-500">Times use your local timezone. Reminders are checked while this page is open; they cannot be delivered if the browser is closed.</p>
                            <p id="reminder-status" class="mt-1 text-xs text-slate-500" aria-live="polite"></p>
                        </label>

                        <div>
                            <div class="mb-2 flex items-center justify-between">
                                <span class="text-xs font-semibold text-slate-700">Tags</span>
                                <button id="add-tag" type="button" class="text-xs font-semibold text-slate-500 hover:text-slate-900">+ Add tag</button>
                            </div>
                            <div id="task-tags" class="flex flex-wrap gap-2"></div>
                        </div>
                    </form>
                </div>

                <div id="drawer-footer" class="flex items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4">
                    <button id="delete-task" type="button" class="inline-flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 transition hover:bg-red-100">
                        <i data-lucide="trash-2" class="h-4 w-4"></i><span>Delete</span>
                    </button>
                    <div class="flex items-center gap-2">
                        <button id="cancel-drawer" type="button" class="rounded-lg bg-slate-100 px-3.5 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-200">Cancel</button>
                        <button id="save-task" type="submit" form="task-form" class="rounded-lg bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800">Save Changes</button>
                    </div>
                </div>
            </aside>

            <aside id="trash-drawer" class="fixed inset-y-0 right-0 z-[60] hidden w-full flex-col border-l border-slate-200 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="trash-title" aria-hidden="true" inert tabindex="-1">
                <div class="flex items-center justify-between border-b border-slate-100 px-6 py-5">
                    <div>
                        <h2 id="trash-title" class="text-lg font-bold">Trash</h2>
                        <p class="mt-1 text-xs text-slate-500">Restore tasks or remove them permanently.</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <button id="clear-trash" type="button" class="clear-trash-button inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100" disabled>
                            <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
                            Clear Trash
                        </button>
                        <button id="close-trash" type="button" aria-label="Close trash" class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-800"><i data-lucide="x" class="h-5 w-5"></i></button>
                    </div>
                </div>
                <p id="trash-action-error" class="hidden mx-5 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert" aria-live="assertive"></p>
                <div id="trash-content" class="flex-1 overflow-y-auto p-6"></div>
            </aside>

            <aside id="history-drawer" class="fixed inset-y-0 right-0 z-[60] hidden w-full flex-col border-l border-slate-200 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="history-title" aria-hidden="true" inert tabindex="-1">
                <div class="flex items-center justify-between border-b border-slate-100 px-6 py-5">
                    <div>
                        <h2 id="history-title" class="text-xl font-semibold text-slate-950">Completed history</h2>
                        <p class="mt-1 text-xs text-slate-500">Completed tasks from earlier days.</p>
                    </div>
                    <button id="close-history" type="button" aria-label="Close completed history" class="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-800"><i data-lucide="x" class="h-5 w-5"></i></button>
                </div>
                <div class="history-filters flex items-center gap-2 border-b border-slate-100 px-5 py-3">
                    <label class="relative min-w-0 flex-1">
                        <span class="sr-only">Search completed history</span>
                        <input id="history-search" type="search" placeholder="Search history..." autocomplete="off" class="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-3 pr-9 text-sm outline-none focus:border-slate-300 focus:bg-white">
                        <button id="clear-history-search" type="button" aria-label="Clear history search" class="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-200"><i data-lucide="x" class="h-4 w-4"></i></button>
                    </label>
                    <label class="priority-filter-control flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-600">
                        <span class="priority-filter-indicator" data-priority="all" aria-hidden="true"></span>
                        <span class="sr-only">Filter history by priority</span>
                        <select id="history-priority-filter" aria-label="Filter history by priority" class="max-w-28 bg-transparent font-medium text-slate-700 outline-none">
                            <option value="all">All</option>
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                        </select>
                    </label>
                </div>
                <div id="history-content" class="flex-1 overflow-y-auto p-6"></div>
            </aside>
        </div>
    </div>

    <script>
        window.initialTasks = <?= json_encode($tasks, JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES) ?>;
        window.initialTextFormatDefaults = <?= json_encode($textFormatDefaults, JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT) ?>;
        window.TASK_MANAGER_CSRF_TOKEN = <?= json_encode($csrfToken, JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT) ?>;
    </script>
    <script src="assets/js/storage.js"></script>
    <script src="assets/js/drawer.js"></script>
    <script src="assets/js/search.js"></script>
    <script src="assets/js/app.js"></script>
    <script src="assets/js/dropdowns.js"></script>
    <script>
        if (window.lucide) {
            window.lucide.createIcons();
        }
    </script>
</body>
</html>
