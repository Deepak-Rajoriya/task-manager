(function ($, window, document) {
    'use strict';

    if (!$) {
        throw new Error('TaskApp requires jQuery to be loaded first.');
    }

    var statuses = ['todo', 'in_progress', 'review', 'done'];
    var statusLabels = {
        todo: 'To Do',
        in_progress: 'In Progress',
        review: 'Review',
        done: 'Done'
    };
    var priorityLabels = {
        low: 'Low',
        medium: 'Medium',
        high: 'High'
    };
    var activeTasks = [];
    var trashTasks = [];
    var textFormatPreviews = Object.create(null);
    var selectedTaskIds = Object.create(null);
    var sortableInstances = [];
    var dragSnapshot = null;
    var pendingTaskIds = Object.create(null);
    var bulkDeletePending = false;
    var clearTrashPending = false;
    var initialized = false;
    var isTrashOpen = false;
    var isHistoryOpen = false;
    var lastTrashFocus = null;
    var lastHistoryFocus = null;
    var bodyOverflow = '';
    var iconRefreshQueued = false;
    var clockTimer = null;
    var taskRefreshPending = false;
    var lastClockDate = '';
    var reminderStates = Object.create(null);
    var pendingReminders = Object.create(null);
    var reminderNotifications = Object.create(null);
    var reminderStackSignature = null;
    var reminderTabId = 'reminder-tab-' + Math.random().toString(36).slice(2);
    var reminderStatePrefix = 'task-manager-reminder-state:v2:';
    var reminderStorageWarningShown = false;

    function escapeText(value) {
        return value == null ? '' : String(value);
    }

    function initialsFor(name) {
        var parts = escapeText(name).trim().split(/\s+/).filter(Boolean);
        if (!parts.length) {
            return '—';
        }
        return parts.slice(0, 2).map(function (part) {
            return part.charAt(0).toLocaleUpperCase();
        }).join('');
    }

    function localDateKey(date) {
        return date.getFullYear()
            + '-'
            + String(date.getMonth() + 1).padStart(2, '0')
            + '-'
            + String(date.getDate()).padStart(2, '0');
    }

    function isValidDateOnly(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }
        var parts = value.split('-').map(Number);
        var date = new Date(parts[0], parts[1] - 1, parts[2]);
        return date.getFullYear() === parts[0]
            && date.getMonth() === parts[1] - 1
            && date.getDate() === parts[2];
    }

    function taskDueState(task, today) {
        if (
            !task
            || task.deleted
            || task.status === 'done'
            || !isValidDateOnly(task.due_date)
        ) {
            return 'none';
        }
        var currentDate = today || localDateKey(new Date());
        if (task.due_date < currentDate) {
            return 'overdue';
        }
        return task.due_date === currentDate ? 'today' : 'future';
    }

    function dueTimestamp(task) {
        if (!task || !isValidDateOnly(task.due_date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.due_time || '')) {
            return null;
        }
        var parts = task.due_date.split('-').map(Number);
        var time = task.due_time.split(':').map(Number);
        var timezone = task.due_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!timezone) {
            return null;
        }

        var targetAsUtc = Date.UTC(parts[0], parts[1] - 1, parts[2], time[0], time[1]);
        var candidate = targetAsUtc;
        var formatter;
        try {
            formatter = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            });
        } catch (error) {
            return null;
        }
        for (var attempt = 0; attempt < 4; attempt += 1) {
            var formattedParts = formatter.formatToParts(new Date(candidate));
            var values = {};
            formattedParts.forEach(function (part) {
                values[part.type] = Number(part.value);
            });
            var representedAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
            var correction = targetAsUtc - representedAsUtc;
            if (correction === 0) {
                return candidate;
            }
            candidate += correction;
        }
        return null;
    }

    function reminderStorageKey(key) {
        return reminderStatePrefix + encodeURIComponent(key);
    }

    function readReminderState(key) {
        var storageKey = reminderStorageKey(key);
        try {
            var saved = window.localStorage.getItem(storageKey);
            if (saved) {
                var state = JSON.parse(saved);
                if (
                    state
                    && ['pending', 'dismissed', 'completed', 'expired'].indexOf(state.status) !== -1
                ) {
                    reminderStates[key] = state;
                    return state;
                }
            }
        } catch (error) {
            if (!reminderStorageWarningShown) {
                console.warn('Reminder state could not be read; reminders may repeat after a page reload.', error);
                reminderStorageWarningShown = true;
            }
        }
        return reminderStates[key] || null;
    }

    function writeReminderState(key, state) {
        reminderStates[key] = state;
        try {
            window.localStorage.setItem(reminderStorageKey(key), JSON.stringify(state));
        } catch (error) {
            if (!reminderStorageWarningShown) {
                console.warn('Reminder state could not be saved; reminders may repeat after a page reload.', error);
                reminderStorageWarningShown = true;
            }
        }
    }

    function reminderCycleKey(task) {
        return task.id + ':' + task.due_date + ':' + task.due_time + ':' + task.reminder_minutes;
    }

    function reminderDueLabel(task) {
        return formatDate(task.due_date)
            + ' at '
            + task.due_time
            + (task.due_timezone ? ' (' + task.due_timezone + ')' : '');
    }

    function closeReminderNotification(key) {
        var notification = reminderNotifications[key];
        if (notification) {
            notification.close();
            delete reminderNotifications[key];
        }
    }

    function notifyReminder(task, cycleKey, state) {
        if (
            !('Notification' in window)
            || Notification.permission !== 'granted'
            || state.notified
        ) {
            return;
        }

        var claimKey = reminderStorageKey(cycleKey) + ':notification-claim';
        var claimToken = reminderTabId + ':' + Date.now();
        try {
            var existingClaim = window.localStorage.getItem(claimKey);
            if (existingClaim) {
                var claimParts = existingClaim.split(':');
                var claimTime = Number(claimParts.pop());
                if (Number.isFinite(claimTime) && Date.now() - claimTime < 30000) {
                    return;
                }
            }
            window.localStorage.setItem(claimKey, claimToken);
            if (window.localStorage.getItem(claimKey) !== claimToken) {
                return;
            }
        } catch (error) {
            if (!reminderStorageWarningShown) {
                console.warn('Desktop notification coordination is unavailable.', error);
                reminderStorageWarningShown = true;
            }
        }

        state.notified = true;
        writeReminderState(cycleKey, state);
        var title = window.TaskStorage.formatText(task.title, task.text_format.title);
        try {
            var notification = new Notification('Task Reminder', {
                body: title + '\nYour task is due in ' + task.reminder_minutes + ' minutes. Due ' + reminderDueLabel(task) + '. Priority: ' + priorityLabels[task.priority] + '.',
                icon: 'assets/images/favicon.ico',
                tag: reminderStorageKey(cycleKey),
                renotify: false
            });
            reminderNotifications[cycleKey] = notification;
            notification.onclick = function () {
                notification.close();
                delete reminderNotifications[cycleKey];
                if (typeof window.focus === 'function') {
                    window.focus();
                }
                window.setTimeout(function () {
                    var currentTask = activeTasks.find(function (item) {
                        return item.id === task.id && !item.deleted && item.status !== 'done';
                    });
                    if (currentTask && window.TaskDrawer) {
                        window.TaskDrawer.openView(currentTask.id).fail(function (error) {
                            setStatus(error && error.message
                                ? 'Could not open the reminded task: ' + error.message
                                : 'Could not open the reminded task.', true, false);
                        });
                    }
                }, 150);
            };
            notification.onclose = function () {
                if (reminderNotifications[cycleKey] === notification) {
                    delete reminderNotifications[cycleKey];
                }
            };
        } catch (error) {
            console.warn('A browser notification could not be displayed.', error);
        }
    }

    function ensureReminderStack() {
        var $stack = $('#task-reminder-stack');
        if ($stack.length) {
            return $stack;
        }
        $stack = $('<section>', {
            id: 'task-reminder-stack',
            class: 'task-reminder-stack',
            role: 'region',
            'aria-label': 'Task reminders',
            'aria-live': 'polite'
        });
        $('body').append($stack);
        return $stack;
    }

    function reminderCard(key, task) {
        var title = window.TaskStorage.formatText(task.title, task.text_format.title);
        var priorityClass = task.priority === 'high'
            ? 'reminder-priority-high'
            : (task.priority === 'medium' ? 'reminder-priority-medium' : 'reminder-priority-low');
        var $card = $('<article>', {
            class: 'task-reminder-card',
            'data-reminder-key': key,
            'data-task-id': task.id
        });
        var $heading = $('<div>', { class: 'reminder-card-heading' });
        var $headingIcon = $('<span>', { class: 'reminder-card-icon', 'aria-hidden': 'true' })
            .append(icon('bell-ring', 'h-5 w-5'));
        $heading.append(
            $headingIcon,
            $('<div>').append(
                $('<h2>', { class: 'reminder-card-title' }).text('Task Reminder'),
                $('<p>', { class: 'reminder-card-message' }).text('Your task is due in ' + task.reminder_minutes + ' minutes.')
            ),
            $('<button>', {
                type: 'button',
                class: 'reminder-close',
                'data-reminder-action': 'dismiss',
                'data-reminder-key': key,
                'aria-label': 'Dismiss reminder'
            }).append(icon('x', 'h-4 w-4'))
        );
        var $taskDetail = $('<div>', { class: 'reminder-task-detail' }).append(
            $('<p>', { class: 'reminder-task-title' }).text(title),
            $('<span>', { class: 'reminder-priority ' + priorityClass }).text(priorityLabels[task.priority] + ' priority'),
            $('<p>', { class: 'reminder-due-label' }).text('Due ' + reminderDueLabel(task))
        );
        var $actions = $('<div>', { class: 'reminder-card-actions' });
        $actions.append(
            $('<button>', {
                type: 'button',
                class: 'reminder-action reminder-action-view',
                'data-reminder-action': 'view',
                'data-reminder-key': key,
                'data-task-id': task.id
            }).text('View Task'),
            $('<button>', {
                type: 'button',
                class: 'reminder-action reminder-action-done',
                'data-reminder-action': 'done',
                'data-reminder-key': key,
                'data-task-id': task.id
            }).text('Mark as Done'),
            $('<button>', {
                type: 'button',
                class: 'reminder-action reminder-action-dismiss',
                'data-reminder-action': 'dismiss',
                'data-reminder-key': key
            }).text('Dismiss')
        );
        $card.append($heading, $taskDetail, $('<p>', {
            class: 'reminder-action-error',
            role: 'alert'
        }).hide(), $actions);
        return $card;
    }

    function renderReminderStack() {
        var keys = Object.keys(pendingReminders);
        var signature = JSON.stringify(keys.map(function (key) {
            var task = pendingReminders[key];
            return [key, task && task.title, task && task.priority, task && task.text_format];
        }));
        var $stack = ensureReminderStack();
        var changed = signature !== reminderStackSignature;
        if (changed) {
            $stack.empty();
            keys.forEach(function (key) {
                var task = pendingReminders[key];
                if (task) {
                    $stack.append(reminderCard(key, task));
                }
            });
            reminderStackSignature = signature;
        }
        $stack.toggleClass('is-visible', keys.length > 0).attr('aria-hidden', keys.length ? 'false' : 'true');
        if (changed && keys.length) {
            scheduleIconRefresh();
        }
    }

    function finishReminder(key, status) {
        var state = readReminderState(key) || {};
        state.status = status;
        state.handledAt = new Date().toISOString();
        writeReminderState(key, state);
        delete pendingReminders[key];
        closeReminderNotification(key);
        renderReminderStack();
    }

    function reconcilePendingReminders(now) {
        Object.keys(pendingReminders).forEach(function (key) {
            var task = pendingReminders[key];
            var reminderState = readReminderState(key);
            var currentTask = activeTasks.find(function (item) {
                return item.id === task.id;
            });
            var currentDeadline = currentTask ? dueTimestamp(currentTask) : null;
            if (reminderState && reminderState.status !== 'pending') {
                delete pendingReminders[key];
                closeReminderNotification(key);
            } else if (!currentTask || currentTask.deleted || currentTask.status === 'done') {
                finishReminder(key, 'completed');
            } else if (
                reminderCycleKey(currentTask) !== key
                || currentDeadline === null
                || now >= currentDeadline
            ) {
                if (now >= currentDeadline && currentDeadline !== null) {
                    finishReminder(key, 'expired');
                } else {
                    delete pendingReminders[key];
                    closeReminderNotification(key);
                }
            }
        });
    }

    function checkDueReminders(now) {
        var currentTime = now || Date.now();
        activeTasks.forEach(function (task) {
            if (
                task.deleted
                || task.status === 'done'
                || !task.due_time
                || (task.reminder_minutes !== 5 && task.reminder_minutes !== 10)
            ) {
                return;
            }
            var deadline = dueTimestamp(task);
            if (deadline === null) {
                return;
            }
            var cycleKey = reminderCycleKey(task);
            var state = readReminderState(cycleKey);
            if (currentTime >= deadline) {
                if (state && state.status === 'pending') {
                    finishReminder(cycleKey, 'expired');
                }
                return;
            }
            var reminderAt = deadline - task.reminder_minutes * 60000;
            if (currentTime < reminderAt) {
                return;
            }
            if (state && state.status !== 'pending') {
                return;
            }
            if (!state) {
                state = { status: 'pending', notified: false, triggeredAt: new Date(currentTime).toISOString() };
                writeReminderState(cycleKey, state);
            }
            pendingReminders[cycleKey] = task;
            notifyReminder(task, cycleKey, state);
        });
        reconcilePendingReminders(currentTime);
        renderReminderStack();
    }

    function refreshTasksWhenVisible() {
        if (
            taskRefreshPending
            || !window.TaskStorage
            || typeof window.TaskStorage.listTasks !== 'function'
            || typeof window.TaskStorage.listTrashTasks !== 'function'
        ) {
            checkDueReminders(Date.now());
            return;
        }
        taskRefreshPending = true;
        $.when(
            window.TaskStorage.listTasks(),
            window.TaskStorage.listTrashTasks()
        ).done(function (tasks, deletedTasks) {
            if (Array.isArray(tasks) && Array.isArray(deletedTasks)) {
                storeTasks(tasks.concat(deletedTasks));
                renderBoard();
                initializeSortable();
            }
            checkDueReminders(Date.now());
        }).fail(function (error) {
            console.warn('Task refresh after tab activation failed.', error);
            checkDueReminders(Date.now());
        }).always(function () {
            taskRefreshPending = false;
        });
    }

    function taskCompletionDate(task) {
        if (!task || task.status !== 'done') {
            return null;
        }
        var timestamp = typeof task.completed_at === 'string' && task.completed_at
            ? task.completed_at
            : task.updated_at;
        if (typeof timestamp !== 'string' || !timestamp || Number.isNaN(Date.parse(timestamp))) {
            return null;
        }
        return localDateKey(new Date(timestamp));
    }

    function tasksForBoard() {
        var today = localDateKey(new Date());
        return activeTasks.filter(function (task) {
            return task.status !== 'done' || taskCompletionDate(task) === today;
        });
    }

    function tasksForHistory() {
        var today = localDateKey(new Date());
        return activeTasks.filter(function (task) {
            if (task.status !== 'done') {
                return false;
            }
            var completedDate = taskCompletionDate(task);
            return !completedDate || completedDate < today;
        });
    }

    function formatDate(value) {
        if (!value) {
            return 'No due date';
        }
        var date;
        if (isValidDateOnly(value)) {
            var parts = value.split('-').map(Number);
            date = new Date(parts[0], parts[1] - 1, parts[2]);
        } else {
            date = new Date(value);
        }
        if (Number.isNaN(date.getTime())) {
            return value;
        }
        return new Intl.DateTimeFormat(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }).format(date);
    }

    function formatDueDateTime(task) {
        if (!task || !task.due_date) {
            return 'No due date';
        }
        return formatDate(task.due_date) + (task.due_time ? ' at ' + task.due_time : '');
    }

    function updateLiveClock() {
        var $clock = $('#live-clock');
        if (!$clock.length || !document.documentElement.contains($clock[0])) {
            if (clockTimer !== null) {
                window.clearInterval(clockTimer);
                clockTimer = null;
            }
            return;
        }

        var now = new Date();
        checkDueReminders(now.getTime());
        var dateKey = localDateKey(now);
        var month = new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(now);
        $('#live-date')
            .text(String(now.getDate()).padStart(2, '0') + ' ' + month + ' ' + now.getFullYear())
            .attr('datetime', dateKey);
        $('#live-time')
            .text([
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join(':'))
            .attr('datetime', dateKey + 'T' + [
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join(':'));

        if (lastClockDate && dateKey !== lastClockDate) {
            renderBoard();
            if (isHistoryOpen) {
                renderHistory();
            }
        }
        lastClockDate = dateKey;
    }

    function startLiveClock() {
        if (clockTimer !== null) {
            window.clearInterval(clockTimer);
        }
        lastClockDate = '';
        updateLiveClock();
        clockTimer = window.setInterval(updateLiveClock, 1000);
    }

    function icon(name, className) {
        return $('<i>').attr('data-lucide', name).addClass(className || 'h-4 w-4');
    }

    function refreshIcons() {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
        }
    }

    function scheduleIconRefresh() {
        if (iconRefreshQueued) {
            return;
        }
        iconRefreshQueued = true;
        window.requestAnimationFrame(function () {
            iconRefreshQueued = false;
            refreshIcons();
        });
    }

    function setStatus(message, isError, showRetry) {
        var $main = $('main').first();
        if (!$main.length) {
            return;
        }
        var $region = $('#app-status');

        if (!$region.length) {
            $region = $('<div>', {
                id: 'app-status',
                role: isError ? 'alert' : 'status',
                'aria-live': isError ? 'assertive' : 'polite'
            }).addClass('mb-5 rounded-xl border px-4 py-3 text-sm');
            $main.prepend($region);
        }

        $region
            .attr('role', isError ? 'alert' : 'status')
            .attr('aria-live', isError ? 'assertive' : 'polite')
            .toggleClass('border-red-200 bg-red-50 text-red-800', !!isError)
            .toggleClass('border-slate-200 bg-white text-slate-600', !isError)
            .empty()
            .append(document.createTextNode(message));

        if (showRetry) {
            var $retry = $('<button>', {
                type: 'button',
                id: 'retry-load-tasks',
                class: 'ml-3 font-semibold underline underline-offset-2 hover:no-underline'
            }).text('Try again');
            $region.append($retry);
        }
        $region.toggleClass('hidden', !message);
    }

    function setLoading(loading) {
        var $board = $('#kanban-board');
        $board.attr('aria-busy', loading ? 'true' : 'false');
        if (loading) {
            setStatus('Loading tasks…', false, false);
        } else if ($('#app-status').attr('role') === 'status') {
            setStatus('', false, false);
        }
    }

    function normalizedTask(task) {
        if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
            return null;
        }
        var status = statuses.indexOf(task.status) !== -1 ? task.status : 'todo';
        var priority = Object.prototype.hasOwnProperty.call(priorityLabels, task.priority)
            ? task.priority
            : 'medium';
        var normalized = $.extend({}, task, {
            title: escapeText(task.title),
            description: escapeText(task.description),
            status: status,
            priority: priority,
            due_date: escapeText(task.due_date),
            due_time: escapeText(task.due_time),
            reminder_minutes: task.reminder_minutes === 5 || task.reminder_minutes === 10
                ? task.reminder_minutes
                : null,
            due_timezone: escapeText(task.due_timezone),
            assignee: escapeText(task.assignee),
            tags: Array.isArray(task.tags) ? task.tags.slice() : [],
            text_format: window.TaskStorage.normalizeTextFormat(task.text_format),
            deleted: task.deleted === true
        });
        if (typeof task.completed_at !== 'string') {
            delete normalized.completed_at;
        }
        return normalized;
    }

    function storeTasks(tasks) {
        if (!Array.isArray(tasks)) {
            throw new TypeError('Task list response must be an array.');
        }
        var normalized = tasks.map(normalizedTask).filter(Boolean);
        activeTasks = normalized.filter(function (task) {
            return !task.deleted;
        });
        trashTasks = normalized.filter(function (task) {
            return task.deleted;
        });
        if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
            window.TaskDrawer.setTasks(normalized);
        }
        $(document).trigger('taskmanager:tasks-loaded', [normalized.slice()]);
    }

    function priorityClass(priority) {
        return 'priority-' + (Object.prototype.hasOwnProperty.call(priorityLabels, priority) ? priority : 'medium');
    }

    function displayTaskText(task, field) {
        var preferences = textFormatPreviews[task.id] || task.text_format;
        return window.TaskStorage.formatText(task[field], preferences[field]);
    }

    function makeTaskCard(task) {
        var displayTitle = displayTaskText(task, 'title');
        var $card = $('<article>', {
            class: 'task-card group cursor-pointer rounded-xl border border-slate-200/80 bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md',
            'data-task-id': task.id,
            'data-status': task.status,
            'data-priority': task.priority,
            draggable: 'true',
            tabindex: '0',
            role: 'group',
            'aria-label': 'View task: ' + displayTitle,
            'aria-keyshortcuts': 'Enter Space'
        });

        var $top = $('<div>', { class: 'task-card-toolbar flex items-center gap-2' });
        var $selection = $('<label>', {
            class: 'task-selection',
            title: 'Select ' + displayTitle
        });
        var $checkbox = $('<input>', {
            type: 'checkbox',
            class: 'task-select-checkbox',
            'data-select-task-id': task.id,
            'aria-label': 'Select ' + displayTitle
        }).prop('checked', Boolean(selectedTaskIds[task.id]));
        $selection.append($checkbox);
        var $priority = $('<span>', {
            class: 'priority-badge ' + priorityClass(task.priority)
        }).text(priorityLabels[task.priority] || 'Medium');
        var $title = $('<h3>', {
            class: 'task-title task-card-title min-w-0 flex-1 truncate text-sm font-bold text-slate-900',
            title: displayTitle
        }).text(displayTitle);
        var dueState = taskDueState(task);
        var $badges = $('<div>', { class: 'task-card-badges flex shrink-0 items-center gap-1.5' }).append($priority);
        if (dueState === 'overdue') {
            $badges.append($('<span>', {
                class: 'overdue-badge',
                title: 'This task is past its due date'
            }).text('Overdue'));
        }
        var $menuButton = $('<button>', {
            type: 'button',
            class: 'task-menu rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700',
            'aria-label': 'Actions for ' + displayTitle,
            'aria-haspopup': 'menu',
            'aria-expanded': 'false'
        }).append(icon('ellipsis-vertical', 'h-[18px] w-[18px]'));
        $top.append($selection, $title, $badges, $menuButton);
        if (selectedTaskIds[task.id]) {
            $card.addClass('is-selected').attr('aria-selected', 'true');
        } else {
            $card.attr('aria-selected', 'false');
        }
        if (dueState === 'overdue') {
            $card.addClass('is-overdue');
        }
        $card.append($top);
        $card.append($('<p>', {
            class: 'task-description mt-2 text-xs leading-[1.45] text-slate-500'
        }).text(task.description ? displayTaskText(task, 'description') : 'No description provided.'));

        var $metadata = $('<div>', {
            class: 'task-card-metadata mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5'
        });
        var $assignee = $('<div>', { class: 'flex min-w-0 items-center gap-2' });
        $assignee.append($('<span>', {
            class: 'assignee-avatar',
            'aria-hidden': 'true'
        }).text(initialsFor(task.assignee)));
        $assignee.append($('<span>', {
            class: 'truncate text-[11px] font-medium text-slate-500',
            title: task.assignee || 'Unassigned'
        }).text(task.assignee || 'Unassigned'));

        var dueDateClass = dueState === 'overdue'
            ? 'due-date-indicator is-overdue'
            : (dueState === 'today' ? 'due-date-indicator is-due-today' : 'due-date-indicator');
        var dueLabel = dueState === 'today' ? 'Due today' : formatDate(task.due_date);
        if (task.due_time) {
            dueLabel += ' ' + task.due_time;
        }
        var $dueDate = $('<span>', {
            class: 'flex shrink-0 items-center gap-1 text-[11px] text-slate-400 ' + dueDateClass,
            title: task.due_date ? 'Due ' + formatDueDateTime(task) : 'No due date'
        });
        $dueDate.append(icon(dueState === 'overdue' ? 'calendar-x' : 'calendar-days', 'h-3.5 w-3.5'));
        $dueDate.append($('<span>').text(dueLabel));
        $metadata.append($assignee, $dueDate);
        $card.append($metadata);

        var $menu = $('<div>', {
            class: 'task-card-menu absolute right-3 top-10 z-20 hidden min-w-36 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg',
            role: 'menu'
        });
        [
            ['view', 'View details', 'eye'],
            ['edit', 'Edit task', 'pencil'],
            ['trash', 'Move to Trash', 'trash-2']
        ].forEach(function (item) {
            var $action = $('<button>', {
                type: 'button',
                class: 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition hover:bg-slate-50',
                'data-card-action': item[0],
                role: 'menuitem'
            }).append(icon(item[2], 'h-3.5 w-3.5 text-slate-500'));
            $action.append(document.createTextNode(item[1]));
            if (item[0] === 'trash') {
                $action.addClass('text-red-600 hover:bg-red-50');
            } else {
                $action.addClass('text-slate-700');
            }
            $menu.append($action);
        });
        $card.append($menu);
        return $card;
    }

    function makeEmptyState(status) {
        var isDone = status === 'done';
        var $empty = $('<div>', {
            class: 'column-empty rounded-xl border border-dashed border-slate-300/90 bg-white/60 px-3 py-8 text-center',
            'data-status': status
        });
        var $iconWrap = $('<span>', {
            class: isDone
                ? 'mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600'
                : 'mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400'
        }).append(icon(isDone ? 'check' : 'file-text', 'h-5 w-5'));
        $empty.append($iconWrap);

        $empty.append($('<p>', {
            class: 'text-sm font-semibold text-slate-700'
        }).text(isDone ? 'Great work!' : 'No more tasks'));
        $empty.append($('<p>', {
            class: 'mx-auto mt-1 max-w-[190px] text-xs leading-5 text-slate-500'
        }).text(isDone
            ? 'All tasks in this column are completed.'
            : 'Add a new task to keep things moving.'));

        if (!isDone) {
            var $button = $('<button>', {
                type: 'button',
                class: 'quick-add mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50',
                'data-status': status
            }).append(icon('plus', 'h-3.5 w-3.5'));
            $button.append(document.createTextNode(' Add task'));
            $empty.append($button);
        }
        return $empty;
    }

    function renderBoard() {
        var boardTasks = tasksForBoard();
        var visibleIds = Object.create(null);
        boardTasks.forEach(function (task) {
            visibleIds[task.id] = true;
        });
        Object.keys(selectedTaskIds).forEach(function (taskId) {
            if (!visibleIds[taskId]) {
                delete selectedTaskIds[taskId];
            }
        });

        statuses.forEach(function (status) {
            var $list = $('.task-list[data-status="' + status + '"]').first();
            if (!$list.length) {
                return;
            }
            $list.empty();
            var tasksForStatus = boardTasks.filter(function (task) {
                return task.status === status;
            });
            tasksForStatus.forEach(function (task) {
                $list.append(makeTaskCard(task));
            });
            if (!tasksForStatus.length) {
                $list.append(makeEmptyState(status));
            }
            $list.closest('.kanban-column').find('.task-count').first().text(tasksForStatus.length);
            var $column = $list.closest('.kanban-column');
            if (!$column.children('.column-add-task').length) {
                var $addButton = $('<button>', {
                    type: 'button',
                    class: 'column-add-task quick-add mt-3 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-500 transition hover:bg-white hover:text-slate-900',
                    'data-status': status,
                    'aria-label': 'Add task to ' + statusLabels[status]
                }).append(icon('plus', 'h-4 w-4'));
                $addButton.append(document.createTextNode('Add task'));
                $column.append($addButton);
            }
        });

        updateSummary(boardTasks.length);
        if (window.TaskSearch && typeof window.TaskSearch.setTasks === 'function') {
            window.TaskSearch.setTasks(boardTasks);
        } else {
            $(document).trigger('taskmanager:board-rendered', [boardTasks.slice()]);
        }
        renderBulkToolbar();
        scheduleIconRefresh();
    }

    function updateSummary(boardTaskCount) {
        var taskCount = typeof boardTaskCount === 'number' ? boardTaskCount : tasksForBoard().length;
        $('#total-tasks').text(taskCount);
        $('#visible-task-count').text(taskCount);
        $('#filtered-task-summary').addClass('hidden');
        var overdueCount = activeOverdueCount();
        $('#overdue-summary')
            .text(overdueCount + ' overdue task' + (overdueCount === 1 ? '' : 's'))
            .toggleClass('hidden', overdueCount === 0);
        $('#board-summary').attr('aria-label', taskCount + ' tasks on the board'
            + (overdueCount ? ', ' + overdueCount + ' overdue tasks' : ''));
        var $trashButton = $('#open-trash');
        var $count = $('#trash-count');
        if (!$count.length) {
            $count = $('<span>', {
                id: 'trash-count',
                class: 'ml-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600',
                'aria-label': 'tasks in Trash'
            });
            $trashButton.append($count);
        }
        $count.text(trashTasks.length).toggleClass('hidden', trashTasks.length === 0);
    }

    function activeOverdueCount() {
        return activeTasks.filter(function (task) {
            return taskDueState(task) === 'overdue';
        }).length;
    }

    function renderBulkToolbar() {
        var selectedCount = Object.keys(selectedTaskIds).length;
        var $toolbar = $('#bulk-actions-toolbar');
        $('#selected-task-count').text(selectedCount);
        $toolbar.toggleClass('hidden', selectedCount === 0);

        var visibleTasks = window.TaskSearch && typeof window.TaskSearch.getFilteredTasks === 'function'
            ? window.TaskSearch.getFilteredTasks()
            : tasksForBoard();
        var visibleIds = visibleTasks.map(function (task) {
            return task.id;
        });
        var allVisibleSelected = visibleIds.length > 0 && visibleIds.every(function (id) {
            return Boolean(selectedTaskIds[id]);
        });
        $('#toggle-select-all').text(allVisibleSelected ? 'Deselect all' : 'Select all')
            .prop('disabled', visibleIds.length === 0);
    }

    function showLoadingBoard() {
        var $board = $('#kanban-board');
        $board.attr('aria-busy', 'true');
        $board.find('.task-list').each(function () {
            $(this).empty().append($('<div>', {
                class: 'animate-pulse rounded-xl border border-slate-200 bg-white/80 p-4 text-sm text-slate-400'
            }).text('Loading tasks…'));
        });
    }

    function loadTasks() {
        if (
            !window.TaskStorage
            || typeof window.TaskStorage.listTasks !== 'function'
            || typeof window.TaskStorage.listTrashTasks !== 'function'
        ) {
            setStatus('Task storage is unavailable. Reload the page and try again.', true, false);
            $('#kanban-board').attr('aria-busy', 'false');
            return;
        }

        setLoading(true);
        showLoadingBoard();
        $.when(
            window.TaskStorage.listTasks(),
            window.TaskStorage.listTrashTasks()
        ).done(function (tasks, deletedTasks) {
            try {
                if (!Array.isArray(tasks) || !Array.isArray(deletedTasks)) {
                    throw new TypeError('The server returned an invalid task collection.');
                }
                storeTasks(tasks.concat(deletedTasks));
                setLoading(false);
                setStatus('', false, false);
                renderBoard();
                if (window.TaskSearch && typeof window.TaskSearch.init === 'function') {
                    window.TaskSearch.init();
                }
                initializeSortable();
                if (isTrashOpen) {
                    renderTrash();
                }
            } catch (error) {
                setLoading(false);
                setStatus(error.message || 'Task data could not be displayed.', true, true);
                $('#kanban-board').attr('aria-busy', 'false');
            }
        }).fail(function (error) {
            setLoading(false);
            setStatus(error && error.message
                ? 'Tasks could not be loaded: ' + error.message
                : 'Tasks could not be loaded. Check the PHP server and try again.', true, true);
            $('#kanban-board').attr('aria-busy', 'false');
        });
    }

    function taskById(taskId) {
        return activeTasks.find(function (task) {
            return task.id === taskId;
        }) || trashTasks.find(function (task) {
            return task.id === taskId;
        }) || null;
    }

    function updateTaskRecord(task) {
        var normalized = normalizedTask(task);
        if (!normalized) {
            return;
        }
        activeTasks = activeTasks.filter(function (item) {
            return item.id !== normalized.id;
        });
        trashTasks = trashTasks.filter(function (item) {
            return item.id !== normalized.id;
        });
        if (normalized.deleted) {
            trashTasks.unshift(normalized);
            delete selectedTaskIds[normalized.id];
        } else {
            activeTasks.unshift(normalized);
        }
        if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
            window.TaskDrawer.setTasks(activeTasks.concat(trashTasks));
        }
        renderBoard();
        if (isHistoryOpen) {
            renderHistory();
        }
        checkDueReminders(Date.now());
    }

    function removeTaskRecord(task) {
        if (!task || typeof task.id !== 'string') {
            return;
        }
        activeTasks = activeTasks.filter(function (item) {
            return item.id !== task.id;
        });
        trashTasks = trashTasks.filter(function (item) {
            return item.id !== task.id;
        });
        delete selectedTaskIds[task.id];
        if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
            window.TaskDrawer.setTasks(activeTasks.concat(trashTasks));
        }
        renderBoard();
    }

    function getOrderFromDom() {
        var order = [];
        $('.task-list[data-status]').each(function () {
            $(this).children('.task-card[data-task-id]').each(function () {
                order.push($(this).attr('data-task-id'));
            });
        });
        return order;
    }

    function restoreOrder(order) {
        var byId = Object.create(null);
        activeTasks.forEach(function (task) {
            byId[task.id] = task;
        });
        var restored = [];
        order.forEach(function (id) {
            if (byId[id]) {
                restored.push(byId[id]);
                delete byId[id];
            }
        });
        activeTasks.forEach(function (task) {
            if (byId[task.id]) {
                restored.push(task);
            }
        });
        activeTasks = restored;
    }

    function destroySortable() {
        sortableInstances.forEach(function (instance) {
            if (instance && typeof instance.destroy === 'function') {
                instance.destroy();
            }
        });
        sortableInstances = [];
    }

    function initializeSortable() {
        destroySortable();
        if (!window.Sortable || typeof window.Sortable.create !== 'function') {
            return;
        }

        $('.task-list[data-status]').each(function () {
            var element = this;
            var instance = window.Sortable.create(element, {
                group: {
                    name: 'kanban-tasks',
                    pull: true,
                    put: true
                },
                draggable: '.task-card',
                filter: 'button, input, label, .task-card-menu',
                preventOnFilter: false,
                animation: 160,
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                dragClass: 'sortable-drag',
                fallbackOnBody: true,
                swapThreshold: 0.65,
                onStart: function () {
                    dragSnapshot = {
                        order: getOrderFromDom(),
                        statuses: activeTasks.reduce(function (result, task) {
                            result[task.id] = task.status;
                            return result;
                        }, {})
                    };
                },
                onMove: function (event) {
                    $(event.to).closest('.kanban-column').addClass('is-drop-target');
                    return true;
                },
                onEnd: function (event) {
                    $('.kanban-column').removeClass('is-drop-target');
                    var taskId = $(event.item).attr('data-task-id');
                    var destinationStatus = $(event.to).attr('data-status');
                    var task = taskById(taskId);
                    if (!task || trashTasks.some(function (item) {
                        return item.id === taskId;
                    })) {
                        renderBoard();
                        if (isHistoryOpen) {
                            renderHistory();
                        }
                        return;
                    }

                    if (!Object.prototype.hasOwnProperty.call(statusLabels, destinationStatus)) {
                        renderBoard();
                        return;
                    }

                    if (pendingTaskIds[taskId]) {
                        renderBoard();
                        return;
                    }

                    var previousStatus = dragSnapshot && dragSnapshot.statuses[taskId]
                        ? dragSnapshot.statuses[taskId]
                        : task.status;
                    var oldOrder = dragSnapshot ? dragSnapshot.order.slice() : [];
                    var newOrder = getOrderFromDom();
                    var sourceStatus = previousStatus;
                    var changedStatus = destinationStatus !== previousStatus;
                    restoreOrder(newOrder);
                    if (changedStatus) {
                        task.status = destinationStatus;
                    }
                    renderBoard();
                    dragSnapshot = null;

                    if (!changedStatus) {
                        return;
                    }
                    if (!window.TaskStorage || typeof window.TaskStorage.updateTask !== 'function') {
                        task.status = previousStatus;
                        restoreOrder(oldOrder);
                        renderBoard();
                        setStatus('Task storage is unavailable; the task was moved back.', true, false);
                        return;
                    }

                    pendingTaskIds[taskId] = true;
                    window.TaskStorage.updateTask(taskId, {
                        title: task.title,
                        description: task.description,
                        status: destinationStatus,
                        priority: task.priority,
                        due_date: task.due_date,
                        assignee: task.assignee,
                        tags: task.tags
                    }).done(function (updatedTask) {
                        var latest = normalizedTask(updatedTask);
                        if (latest) {
                            latest.status = destinationStatus;
                            var index = activeTasks.findIndex(function (item) {
                                return item.id === taskId;
                            });
                            if (index !== -1) {
                                activeTasks[index] = latest;
                            }
                            if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
                                window.TaskDrawer.setTasks(activeTasks.concat(trashTasks));
                            }
                            renderBoard();
                        }
                        setStatus('', false, false);
                    }).fail(function (error) {
                        var current = taskById(taskId);
                        if (current) {
                            current.status = sourceStatus;
                        }
                        restoreOrder(oldOrder);
                        renderBoard();
                        setStatus(error && error.message
                            ? 'Could not move task: ' + error.message
                            : 'Could not save the new task status. The task was moved back.', true, false);
                    }).always(function () {
                        delete pendingTaskIds[taskId];
                    });
                }
            });
            sortableInstances.push(instance);
        });
    }

    function openTrash() {
        var $trash = $('#trash-drawer');
        var $overlay = $('#drawer-overlay');
        if (!$trash.length) {
            setStatus('Trash view is unavailable.', true, false);
            return;
        }

        if (!isTrashOpen) {
            lastTrashFocus = document.activeElement;
        }
        if (window.TaskDrawer && typeof window.TaskDrawer.close === 'function') {
            window.TaskDrawer.close(false);
        }
        if (isHistoryOpen) {
            closeHistory(false);
        }
        if (!isTrashOpen) {
            bodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
        }
        isTrashOpen = true;

        $trash.removeClass('hidden is-closed').addClass('is-open');
        $trash.attr('aria-hidden', 'false').prop('inert', false).attr('tabindex', '-1');
        $overlay.removeClass('hidden').addClass('is-visible').attr('aria-hidden', 'false');
        renderTrash();
        if (window.TaskStorage && typeof window.TaskStorage.listTrashTasks === 'function') {
            $('#trash-content').attr('aria-busy', 'true');
            window.TaskStorage.listTrashTasks().done(function (tasks) {
                if (!Array.isArray(tasks)) {
                    setTrashError('Trash data could not be displayed.');
                    return;
                }
                trashTasks = tasks.map(normalizedTask).filter(function (task) {
                    return task && task.deleted;
                });
                if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
                    window.TaskDrawer.setTasks(activeTasks.concat(trashTasks));
                }
                renderTrash();
                setTrashError('');
            }).fail(function (error) {
                setTrashError(error && error.message
                    ? 'Trash could not be loaded: ' + error.message
                    : 'Trash could not be loaded. Check the PHP server and try again.');
            }).always(function () {
                $('#trash-content').attr('aria-busy', 'false');
            });
        } else {
            setTrashError('Trash storage is unavailable.');
        }
        $('#close-trash').trigger('focus');
    }

    function setTrashError(message) {
        var $content = $('#trash-content');
        $content.children('.trash-request-error').remove();
        if (message) {
            $content.prepend($('<p>', {
                class: 'trash-request-error request-error mb-4',
                role: 'alert',
                'aria-live': 'assertive'
            }).text(message));
        }
    }

    function closeTrash(restoreFocus) {
        if (!isTrashOpen) {
            return;
        }
        isTrashOpen = false;
        var $trash = $('#trash-drawer');
        var $overlay = $('#drawer-overlay');
        $trash.removeClass('is-open').addClass('is-closed');
        $trash.attr('aria-hidden', 'true').prop('inert', true);
        $overlay.removeClass('is-visible').addClass('hidden').attr('aria-hidden', 'true');
        document.body.style.overflow = bodyOverflow;
        window.setTimeout(function () {
            if (!isTrashOpen) {
                $trash.addClass('hidden').removeClass('is-closed');
            }
        }, window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200);
        if (restoreFocus !== false && lastTrashFocus && document.contains(lastTrashFocus)) {
            lastTrashFocus.focus();
        }
    }

    function openHistory() {
        var $history = $('#history-drawer');
        var $overlay = $('#drawer-overlay');
        if (!$history.length) {
            setStatus('Completed history is unavailable.', true, false);
            return;
        }
        if (!isHistoryOpen) {
            lastHistoryFocus = document.activeElement;
        }
        if (window.TaskDrawer && typeof window.TaskDrawer.close === 'function') {
            window.TaskDrawer.close(false);
        }
        if (isTrashOpen) {
            closeTrash(false);
        }
        if (!isHistoryOpen) {
            bodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
        }
        isHistoryOpen = true;
        $history.removeClass('hidden history-closing').addClass('history-open');
        $history.attr('aria-hidden', 'false').prop('inert', false).attr('tabindex', '-1');
        $overlay.removeClass('hidden').addClass('is-visible').attr('aria-hidden', 'false');
        renderHistory();
        $('#close-history').trigger('focus');
    }

    function closeHistory(restoreFocus) {
        if (!isHistoryOpen) {
            return;
        }
        isHistoryOpen = false;
        var $history = $('#history-drawer');
        var $overlay = $('#drawer-overlay');
        $history.removeClass('history-open').addClass('history-closing');
        $history.attr('aria-hidden', 'true').prop('inert', true);
        $overlay.removeClass('is-visible').addClass('hidden').attr('aria-hidden', 'true');
        document.body.style.overflow = bodyOverflow;
        window.setTimeout(function () {
            if (!isHistoryOpen) {
                $history.addClass('hidden').removeClass('history-closing');
            }
        }, window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
        if (restoreFocus !== false && lastHistoryFocus && document.contains(lastHistoryFocus)) {
            lastHistoryFocus.focus();
        }
    }

    function historyTaskRow(task) {
        var $row = $('<article>', {
            class: 'history-task',
            'data-task-id': task.id
        });
        var $header = $('<div>', { class: 'flex items-start justify-between gap-3' });
        var $details = $('<div>', { class: 'min-w-0' });
        $details.append($('<h3>', { class: 'history-task-title' }).text(displayTaskText(task, 'title')));
        $details.append($('<p>', { class: 'mt-1.5 whitespace-pre-wrap break-words text-sm leading-5 text-slate-600' })
            .text(task.description ? displayTaskText(task, 'description') : 'No description provided.'));
        var completionDate = taskCompletionDate(task);
        $details.append($('<p>', { class: 'mt-2 text-xs font-medium text-slate-500' })
            .text('Completed ' + (completionDate ? formatDate(completionDate) : 'date unknown')));
        $header.append($details);
        var $priority = $('<span>', {
            class: 'priority-badge ' + priorityClass(task.priority)
        }).text(priorityLabels[task.priority] || 'Medium');
        $header.append($priority);
        $row.append($header);

        var $meta = $('<p>', { class: 'mt-2 text-xs leading-5 text-slate-500' });
        $meta.append(document.createTextNode(
            (task.assignee || 'Unassigned')
            + ' · Due '
            + formatDueDateTime(task)
        ));
        $row.append($meta);
        $row.append($('<button>', {
            type: 'button',
            class: 'history-view-task mt-3 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50',
            'data-task-id': task.id
        }).text('View details'));
        return $row;
    }

    function renderHistory() {
        var $content = $('#history-content');
        if (!$content.length) {
            return;
        }
        $content.empty();
        var historyTasks = tasksForHistory();
        var query = window.TaskSearch && typeof window.TaskSearch.getQuery === 'function'
            ? window.TaskSearch.getQuery()
            : '';
        var priority = window.TaskSearch && typeof window.TaskSearch.getPriority === 'function'
            ? window.TaskSearch.getPriority()
            : 'all';
        var filtered = window.TaskSearch && typeof window.TaskSearch.filter === 'function'
            ? window.TaskSearch.filter(historyTasks, query, priority)
            : historyTasks;
        $('#history-title').text('Completed history (' + historyTasks.length + ')');

        if (!filtered.length) {
            var $empty = $('<div>', { class: 'history-empty' });
            $empty.append(icon('history', 'mb-3 h-7 w-7 text-slate-400'));
            $empty.append($('<p>', { class: 'font-semibold text-slate-700' }).text(historyTasks.length
                ? 'No completed tasks match these filters'
                : 'No previous completions'));
            $empty.append($('<p>', { class: 'mt-1 text-xs' }).text(historyTasks.length
                ? 'Try another search or priority.'
                : 'Tasks completed on earlier days will appear here.'));
            $content.append($empty);
        } else {
            filtered.forEach(function (task) {
                $content.append(historyTaskRow(task));
            });
        }
        scheduleIconRefresh();
    }

    function openHistoryTask(taskId) {
        var $returnButton = $('#completed-history-button');
        closeHistory(false);
        $returnButton.trigger('focus');
        if (window.TaskDrawer && typeof window.TaskDrawer.openView === 'function') {
            window.TaskDrawer.openView(taskId).fail(function (error) {
                setStatus(error && error.message ? error.message : 'Could not open completed task.', true, false);
            });
        }
    }

    function trashTaskRow(task) {
        var $row = $('<article>', {
            class: 'trash-task',
            'data-task-id': task.id
        });
        var $header = $('<div>', { class: 'flex items-start justify-between gap-3' });
        var $details = $('<div>', { class: 'min-w-0' });
        $details.append($('<h3>', { class: 'trash-task-title' }).text(displayTaskText(task, 'title')));

        var $meta = $('<p>', { class: 'mt-2 text-xs leading-5 text-slate-500' });
        $meta.append(document.createTextNode(
            (priorityLabels[task.priority] || 'Medium')
            + ' · '
            + (statusLabels[task.status] || statusLabels.todo)
            + ' · '
            + (task.assignee || 'Unassigned')
        ));
        $details.append($meta);
        $header.append($details);
        $row.append($header);

        var $actions = $('<div>', { class: 'mt-3 flex flex-wrap gap-2' });
        $actions.append($('<button>', {
            type: 'button',
            class: 'restore-task rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100',
            'data-task-id': task.id
        }).text('Restore'));
        $actions.append($('<button>', {
            type: 'button',
            class: 'permanently-delete-task rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100',
            'data-task-id': task.id
        }).text('Delete permanently'));
        $row.append($actions);
        return $row;
    }

    function renderTrash() {
        var $content = $('#trash-content');
        if (!$content.length) {
            return;
        }
        $('#clear-trash')
            .prop('disabled', clearTrashPending || trashTasks.length === 0)
            .toggleClass('is-loading', clearTrashPending);
        $content.empty();
        $('#trash-title').text('Trash (' + trashTasks.length + ')');

        if (!trashTasks.length) {
            var $empty = $('<div>', { class: 'trash-empty' });
            $empty.append(icon('trash-2', 'h-7 w-7'));
            $empty.append($('<p>', { class: 'font-semibold text-slate-700' }).text('Trash is empty'));
            $empty.append($('<p>', { class: 'mt-1 text-xs' }).text('Deleted tasks will appear here.'));
            $content.append($empty);
        } else {
            trashTasks.forEach(function (task) {
                $content.append(trashTaskRow(task));
            });
        }
        scheduleIconRefresh();
    }

    function handleTaskChange(event, detail) {
        if (!detail || !detail.task) {
            return;
        }
        updateTaskRecord(detail.task);
        if (isTrashOpen) {
            renderTrash();
        }
        if (isHistoryOpen) {
            renderHistory();
        }
    }

    function handleReminderAction($button) {
        var action = String($button.attr('data-reminder-action') || '');
        var key = String($button.attr('data-reminder-key') || '');
        var taskId = String($button.attr('data-task-id') || '');
        var $card = $button.closest('.task-reminder-card');
        if (!key || !pendingReminders[key]) {
            return;
        }

        if (action === 'dismiss') {
            finishReminder(key, 'dismissed');
            return;
        }
        var task = activeTasks.find(function (item) {
            return item.id === taskId && !item.deleted;
        });
        if (!task) {
            return;
        }
        if (action === 'view') {
            if (window.TaskDrawer && typeof window.TaskDrawer.openView === 'function') {
                window.TaskDrawer.openView(taskId).fail(function (error) {
                    $card.find('.reminder-action-error')
                        .text(error && error.message ? error.message : 'Could not open this task.')
                        .show();
                });
            }
            return;
        }
        if (
            action !== 'done'
            || pendingTaskIds[taskId]
            || !window.TaskStorage
            || typeof window.TaskStorage.updateTask !== 'function'
        ) {
            return;
        }

        pendingTaskIds[taskId] = true;
        $card.find('.reminder-action').prop('disabled', true);
        $card.find('.reminder-action-done').text('Saving…');
        var textFormat = window.TaskStorage.normalizeTextFormat(task.text_format);
        window.TaskStorage.updateTask(taskId, {
            title: task.title,
            description: task.description,
            status: 'done',
            priority: task.priority,
            due_date: task.due_date,
            due_time: task.due_time,
            reminder_minutes: task.reminder_minutes,
            due_timezone: task.due_timezone,
            assignee: task.assignee,
            tags: task.tags,
            text_format: textFormat
        }).done(function (updatedTask) {
            updateTaskRecord(updatedTask);
            finishReminder(key, 'completed');
        }).fail(function (error) {
            $card.find('.reminder-action-error')
                .text(error && error.message ? error.message : 'Could not mark this task as done. Please try again.')
                .show();
            $card.find('.reminder-action-done').text('Mark as Done');
            $card.find('.reminder-action').prop('disabled', false);
        }).always(function () {
            delete pendingTaskIds[taskId];
        });
    }

    function restoreTask(taskId, $button) {
        if (pendingTaskIds[taskId] || !window.TaskStorage) {
            return;
        }
        var task = trashTasks.find(function (item) {
            return item.id === taskId;
        });
        if (!task) {
            return;
        }
        pendingTaskIds[taskId] = true;
        $button.prop('disabled', true).addClass('is-loading');
        window.TaskStorage.restoreTask(taskId).done(function (restored) {
            updateTaskRecord(restored);
            renderTrash();
            setStatus('', false, false);
        }).fail(function (error) {
            $button.prop('disabled', false).removeClass('is-loading');
            setStatus(error && error.message
                ? 'Could not restore task: ' + error.message
                : 'Could not restore this task.', true, false);
        }).always(function () {
            delete pendingTaskIds[taskId];
        });
    }

    function permanentlyDeleteTask(taskId, $button) {
        if (pendingTaskIds[taskId] || !window.TaskStorage) {
            return;
        }
        var task = trashTasks.find(function (item) {
            return item.id === taskId;
        });
        if (!task || !window.confirm('Permanently delete "' + displayTaskText(task, 'title') + '"? This cannot be undone.')) {
            return;
        }

        pendingTaskIds[taskId] = true;
        $button.prop('disabled', true).addClass('is-loading');
        window.TaskStorage.permanentlyDeleteTask(taskId).done(function () {
            removeTaskRecord(task);
            renderTrash();
            setStatus('', false, false);
        }).fail(function (error) {
            $button.prop('disabled', false).removeClass('is-loading');
            setStatus(error && error.message
                ? 'Could not permanently delete task: ' + error.message
                : 'Could not permanently delete this task.', true, false);
        }).always(function () {
            delete pendingTaskIds[taskId];
        });
    }

    function clearTrash() {
        if (
            clearTrashPending
            || !trashTasks.length
            || !window.TaskStorage
            || typeof window.TaskStorage.clearTrashTasks !== 'function'
        ) {
            return;
        }
        var count = trashTasks.length;
        if (!window.confirm(
            'Permanently delete all ' + count + ' task' + (count === 1 ? '' : 's')
            + ' currently in Trash, including their comments? This cannot be undone. '
            + 'Active tasks will not be affected.'
        )) {
            return;
        }

        clearTrashPending = true;
        $('#trash-action-error').addClass('hidden').empty();
        renderTrash();
        window.TaskStorage.clearTrashTasks().done(function (result) {
            var removedIds = Object.create(null);
            result.removed_ids.forEach(function (taskId) {
                removedIds[taskId] = true;
            });
            trashTasks = trashTasks.filter(function (task) {
                return !removedIds[task.id];
            });
            if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
                window.TaskDrawer.setTasks(activeTasks.concat(trashTasks));
            }
            renderBoard();
            renderTrash();
            setStatus('', false, false);
        }).fail(function (error) {
            var message = error && error.message
                ? 'Could not clear Trash: ' + error.message
                : 'Could not clear Trash. Your tasks are still there.';
            $('#trash-action-error').text(message).removeClass('hidden');
        }).always(function () {
            clearTrashPending = false;
            renderTrash();
        });
    }

    function toggleCardMenu($button) {
        var $card = $button.closest('.task-card');
        var $menu = $card.children('.task-card-menu');
        var opening = $menu.hasClass('hidden');
        $('.task-card-menu').addClass('hidden');
        $('.task-menu').attr('aria-expanded', 'false');
        if (opening) {
            $menu.removeClass('hidden');
            $button.attr('aria-expanded', 'true');
            $menu.find('[role="menuitem"]').first().trigger('focus');
        }
    }

    function handleCardAction($button) {
        var $card = $button.closest('.task-card');
        var taskId = String($card.attr('data-task-id') || '');
        var action = $button.attr('data-card-action');
        var task = taskById(taskId);
        $('.task-card-menu').addClass('hidden');
        $('.task-menu').attr('aria-expanded', 'false');
        if (!task || !window.TaskDrawer) {
            return;
        }

        if (action === 'view') {
            window.TaskDrawer.openView(taskId).fail(function () {});
        } else if (action === 'edit') {
            window.TaskDrawer.openEdit(taskId).fail(function () {});
        } else if (action === 'trash') {
            if (!window.confirm('Move "' + displayTaskText(task, 'title') + '" to Trash?')) {
                return;
            }
            pendingTaskIds[taskId] = true;
            window.TaskStorage.softDeleteTask(taskId).done(function (deleted) {
                updateTaskRecord(deleted);
                if (isTrashOpen) {
                    renderTrash();
                }
            }).fail(function (error) {
                setStatus(error && error.message ? error.message : 'Could not move this task to Trash.', true, false);
            }).always(function () {
                delete pendingTaskIds[taskId];
            });
        }
    }

    function updateSelectionDisplay() {
        $('.task-card[data-task-id]').each(function () {
            var id = String($(this).attr('data-task-id') || '');
            var selected = Boolean(selectedTaskIds[id]);
            $(this).toggleClass('is-selected', selected).attr('aria-selected', selected ? 'true' : 'false');
            $(this).find('.task-select-checkbox').prop('checked', selected);
        });
        renderBulkToolbar();
    }

    function clearTaskSelection() {
        selectedTaskIds = Object.create(null);
        updateSelectionDisplay();
    }

    function selectAllVisibleTasks() {
        var visibleTasks = window.TaskSearch && typeof window.TaskSearch.getFilteredTasks === 'function'
            ? window.TaskSearch.getFilteredTasks()
            : tasksForBoard();
        if (!visibleTasks.length) {
            return;
        }
        var allSelected = visibleTasks.every(function (task) {
            return Boolean(selectedTaskIds[task.id]);
        });
        visibleTasks.forEach(function (task) {
            if (allSelected) {
                delete selectedTaskIds[task.id];
            } else {
                selectedTaskIds[task.id] = true;
            }
        });
        updateSelectionDisplay();
    }

    function toggleTaskSelection(taskId, selected) {
        var isBoardTask = tasksForBoard().some(function (task) {
            return task.id === taskId;
        });
        if (!isBoardTask) {
            delete selectedTaskIds[taskId];
        } else if (selected) {
            selectedTaskIds[taskId] = true;
        } else {
            delete selectedTaskIds[taskId];
        }
        updateSelectionDisplay();
    }

    function bulkDeleteSelectedTasks() {
        if (bulkDeletePending || !window.TaskStorage || typeof window.TaskStorage.bulkSoftDeleteTasks !== 'function') {
            return;
        }
        var selectedIds = Object.keys(selectedTaskIds);
        if (!selectedIds.length) {
            return;
        }
        if (selectedIds.length > 100) {
            setStatus('Bulk deletion is limited to 100 tasks at a time.', true, false);
            return;
        }
        if (!window.confirm('Move ' + selectedIds.length + ' selected task'
            + (selectedIds.length === 1 ? '' : 's') + ' to Trash?')) {
            return;
        }

        bulkDeletePending = true;
        $('#bulk-delete-selected, #toggle-select-all, #clear-task-selection')
            .prop('disabled', true);
        window.TaskStorage.bulkSoftDeleteTasks(selectedIds).done(function (result) {
            result.deleted_tasks.forEach(function (task) {
                activeTasks = activeTasks.filter(function (item) {
                    return item.id !== task.id;
                });
                trashTasks = trashTasks.filter(function (item) {
                    return item.id !== task.id;
                });
                trashTasks.unshift(task);
                delete selectedTaskIds[task.id];
            });
            result.rejected_ids.forEach(function (taskId) {
                if (!activeTasks.some(function (task) {
                    return task.id === taskId;
                })) {
                    delete selectedTaskIds[taskId];
                }
            });
            if (window.TaskDrawer && typeof window.TaskDrawer.setTasks === 'function') {
                window.TaskDrawer.setTasks(activeTasks.concat(trashTasks));
            }
            renderBoard();
            if (isTrashOpen) {
                renderTrash();
            }
            if (isHistoryOpen) {
                renderHistory();
            }
            if (result.rejected_ids.length) {
                setStatus(result.deleted_count + ' task'
                    + (result.deleted_count === 1 ? '' : 's')
                    + ' moved to Trash; '
                    + result.rejected_ids.length
                    + ' selected task'
                    + (result.rejected_ids.length === 1 ? ' was' : 's were')
                    + ' not deleted. They remain selected where available.', true, false);
            } else {
                clearTaskSelection();
                setStatus('', false, false);
            }
        }).fail(function (error) {
            setStatus(error && error.message
                ? 'Could not move selected tasks to Trash: ' + error.message
                : 'Could not move selected tasks to Trash. Your selection was kept.', true, false);
        }).always(function () {
            bulkDeletePending = false;
            $('#bulk-delete-selected, #toggle-select-all, #clear-task-selection')
                .prop('disabled', false);
            renderBulkToolbar();
        });
    }

    function bindEvents() {
        $(document)
            .off('.taskApp')
            .on('click.taskApp', '#retry-load-tasks', loadTasks)
            .on('taskmanager:drawer-opening.taskApp', function () {
                $('.column-options-menu').addClass('hidden');
                $('.column-menu-trigger').attr('aria-expanded', 'false');
                if (isTrashOpen) {
                    closeTrash(false);
                }
                if (isHistoryOpen) {
                    closeHistory(false);
                }
            })
            .on('click.taskApp', '#open-trash', openTrash)
            .on('click.taskApp', '#completed-history-button', openHistory)
            .on('click.taskApp', '#close-trash', function () {
                closeTrash(true);
            })
            .on('click.taskApp', '#clear-trash', clearTrash)
            .on('click.taskApp', '#close-history', function () {
                closeHistory(true);
            })
            .on('click.taskApp', '#drawer-overlay', function (event) {
                if (event.target === this) {
                    if (isHistoryOpen) {
                        closeHistory(true);
                    } else if (isTrashOpen) {
                        closeTrash(true);
                    }
                }
            })
            .on('click.taskApp', '#toggle-select-all', selectAllVisibleTasks)
            .on('click.taskApp', '#clear-task-selection', clearTaskSelection)
            .on('click.taskApp', '#bulk-delete-selected', bulkDeleteSelectedTasks)
            .on('change.taskApp', '.task-select-checkbox', function (event) {
                event.stopPropagation();
                toggleTaskSelection(String($(this).attr('data-select-task-id') || ''), this.checked);
            })
            .on('click.taskApp', '.task-select-checkbox', function (event) {
                event.stopPropagation();
            })
            .on('click.taskApp', '.history-view-task', function () {
                openHistoryTask(String($(this).attr('data-task-id') || ''));
            })
            .on('keydown.taskApp', function (event) {
                if (event.key === 'Escape') {
                    if (isHistoryOpen) {
                        event.preventDefault();
                        closeHistory(true);
                    } else if (isTrashOpen) {
                        event.preventDefault();
                        closeTrash(true);
                    } else {
                        $('.task-card-menu').addClass('hidden');
                        $('.task-menu').attr('aria-expanded', 'false');
                        $('.column-options-menu').addClass('hidden');
                        $('.column-menu-trigger').attr('aria-expanded', 'false');
                    }
                }
                if (event.key === 'Tab' && isTrashOpen) {
                    var $focusable = $('#trash-drawer').find('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])').filter(':visible');
                    if ($focusable.length) {
                        var first = $focusable[0];
                        var last = $focusable[$focusable.length - 1];
                        if (event.shiftKey && document.activeElement === first) {
                            event.preventDefault();
                            last.focus();
                        } else if (!event.shiftKey && document.activeElement === last) {
                            event.preventDefault();
                            first.focus();
                        }
                    }
                    if (event.key === 'Tab' && isHistoryOpen) {
                        var $historyFocusable = $('#history-drawer').find('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])').filter(':visible');
                        if ($historyFocusable.length) {
                            var firstHistory = $historyFocusable[0];
                            var lastHistory = $historyFocusable[$historyFocusable.length - 1];
                            if (event.shiftKey && document.activeElement === firstHistory) {
                                event.preventDefault();
                                lastHistory.focus();
                            } else if (!event.shiftKey && document.activeElement === lastHistory) {
                                event.preventDefault();
                                firstHistory.focus();
                            }
                        }
                    }
                }
            })
            .on('click.taskApp', '.task-menu', function (event) {
                event.preventDefault();
                event.stopPropagation();
                toggleCardMenu($(this));
            })
            .on('click.taskApp', '.column-menu-trigger', function (event) {
                event.preventDefault();
                event.stopPropagation();
                var $button = $(this);
                var $menu = $button.closest('.kanban-column').children('.column-options-menu');
                var opening = $menu.hasClass('hidden');
                $('.column-options-menu').addClass('hidden');
                $('.column-menu-trigger').attr('aria-expanded', 'false');
                if (opening) {
                    $menu.removeClass('hidden');
                    $button.attr('aria-expanded', 'true');
                    scheduleIconRefresh();
                }
            })
            .on('click.taskApp', '[data-card-action]', function (event) {
                event.preventDefault();
                event.stopPropagation();
                handleCardAction($(this));
            })
            .on('click.taskApp', '.restore-task', function () {
                restoreTask(String($(this).attr('data-task-id') || ''), $(this));
            })
            .on('click.taskApp', '.permanently-delete-task', function () {
                permanentlyDeleteTask(String($(this).attr('data-task-id') || ''), $(this));
            })
            .on('click.taskApp', function (event) {
                if (!$(event.target).closest('.task-card').length) {
                    $('.task-card-menu').addClass('hidden');
                    $('.task-menu').attr('aria-expanded', 'false');
                }
                if (!$(event.target).closest('.kanban-column-heading, .column-options-menu').length) {
                    $('.column-options-menu').addClass('hidden');
                    $('.column-menu-trigger').attr('aria-expanded', 'false');
                }
            })
            .on('taskmanager:changed.taskApp', handleTaskChange);
        $(document)
            .on('visibilitychange.taskApp', function () {
                if (document.visibilityState === 'visible') {
                    refreshTasksWhenVisible();
                } else {
                    checkDueReminders(Date.now());
                }
            })
            .on('click.taskApp', '[data-reminder-action]', function (event) {
                event.preventDefault();
                event.stopPropagation();
                handleReminderAction($(this));
            });
        $(window)
            .off('.taskApp')
            .on('focus.taskApp pageshow.taskApp', refreshTasksWhenVisible)
            .on('storage.taskApp', function (event) {
                var storageEvent = event.originalEvent || event;
                if (typeof storageEvent.key === 'string' && storageEvent.key.indexOf(reminderStatePrefix) === 0) {
                    checkDueReminders(Date.now());
                }
            });
        $(document)
            .on('taskmanager:text-format-preview.taskApp', function (event, preview) {
                if (!preview || typeof preview.taskId !== 'string' || !preview.textFormat) {
                    return;
                }
                textFormatPreviews[preview.taskId] = window.TaskStorage.normalizeTextFormat(preview.textFormat);
                renderBoard();
                if (isHistoryOpen) {
                    renderHistory();
                }
            })
            .on('taskmanager:text-format-preview-clear.taskApp', function () {
                if (!Object.keys(textFormatPreviews).length) {
                    return;
                }
                textFormatPreviews = Object.create(null);
                renderBoard();
                if (isHistoryOpen) {
                    renderHistory();
                }
                if (isTrashOpen) {
                    renderTrash();
                }
            });
        $(document).on('taskmanager:search.taskApp', function () {
            var overdueCount = activeOverdueCount();
            $('#board-summary').attr('aria-label', tasksForBoard().length + ' tasks on the board'
                + (overdueCount ? ', ' + overdueCount + ' overdue tasks' : ''));
            updateSelectionDisplay();
            if (isHistoryOpen) {
                renderHistory();
            }
        });

    }

    function getTasks() {
        return tasksForBoard();
    }

    function getTrashTasks() {
        return trashTasks.slice();
    }

    var TaskApp = {
        getTasks: getTasks,
        getAllActiveTasks: function () {
            return activeTasks.slice();
        },
        getTrashTasks: getTrashTasks,
        getTaskById: taskById,
        refresh: loadTasks,
        render: renderBoard
    };

    window.TaskApp = Object.freeze(TaskApp);

    function initialize() {
        if (initialized) {
            return;
        }
        initialized = true;
        bindEvents();
        startLiveClock();
        loadTasks();
    }

    $(initialize);
}(window.jQuery, window, document));
