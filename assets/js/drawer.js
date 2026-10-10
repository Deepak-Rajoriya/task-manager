(function ($, window, document) {
    'use strict';

    if (!$) {
        throw new Error('TaskDrawer requires jQuery to be loaded first.');
    }

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
    var assignees = [
        'Deepak Rajoriya',
    ];

    var $drawer;
    var $overlay;
    var $content;
    var $form;
    var $title;
    var $description;
    var $status;
    var $priority;
    var $assignee;
    var $dueDate;
    var $dueTime;
    var $reminderMinutes;
    var $taskId;
    var $tags;
    var $saveButton;
    var $deleteButton;
    var $cancelButton;
    var $heading;
    var $detailsTab;
    var $commentsTab;
    var taskCache = [];
    var currentTask = null;
    var mode = 'closed';
    var lastFocus = null;
    var requestPending = false;
    var bodyOverflow = '';
    var scrollLocked = false;
    var reduceMotion = false;
    var commentRequestPending = false;
    var globalTextFormatDefaults = window.initialTextFormatDefaults
        ? window.TaskStorage.normalizeTextFormat(window.initialTextFormatDefaults)
        : $.extend({}, window.TaskStorage.defaultTextFormat);
    var activeTextFormat = $.extend({}, globalTextFormatDefaults);

    function refreshElements() {
        $drawer = $('#task-drawer');
        $overlay = $('#drawer-overlay');
        $content = $('#drawer-content');
        $form = $('#task-form');
        $title = $('#task-title');
        $description = $('#task-description');
        $status = $('#task-status');
        $priority = $('#task-priority');
        $assignee = $('#task-assignee');
        $dueDate = $('#task-due-date');
        $dueTime = $('#task-due-time');
        $reminderMinutes = $('#task-reminder-minutes');
        $taskId = $('#task-id');
        $tags = $('#task-tags');
        $saveButton = $('#save-task');
        $deleteButton = $('#delete-task');
        $cancelButton = $('#cancel-drawer');
        $heading = $('#drawer-title');
        $detailsTab = $('#task-details-tab');
        $commentsTab = $('#task-comments-tab');
    }

    function safeText(value) {
        return value == null ? '' : String(value);
    }

    function formattedText(value, field, preferences) {
        var formats = preferences || activeTextFormat;
        return window.TaskStorage.formatText(value, formats[field]);
    }

    function renderTextFormatControls(preferences) {
        activeTextFormat = window.TaskStorage.normalizeTextFormat(preferences);
        $('.text-format-button').each(function () {
            var $button = $(this);
            var active = activeTextFormat[$button.attr('data-format-field')] === $button.attr('data-format-mode');
            $button.toggleClass('is-active', active).attr('aria-pressed', active ? 'true' : 'false');
        });
        updateTextPreviews();
    }

    function updateTextPreviews() {
        if (!$title || !$description) {
            return;
        }
        $('#task-title-preview').text(formattedText($title.val(), 'title'));
        $('#task-description-preview').text(formattedText($description.val(), 'description'));
    }

    function changeTextFormat(field, format) {
        var previous = activeTextFormat[field];
        if (!['title', 'description'].includes(field) || previous === format) {
            return;
        }
        var preferences = $.extend({}, activeTextFormat);
        preferences[field] = format;
        renderTextFormatControls(preferences);
        if (mode === 'edit' && currentTask) {
            $(document).trigger('taskmanager:text-format-preview', [{
                taskId: currentTask.id,
                textFormat: $.extend({}, preferences)
            }]);
        }
        if (mode === 'add') {
            globalTextFormatDefaults = $.extend({}, globalTextFormatDefaults, { [field]: format });
            window.TaskStorage.saveTextFormatDefaults(globalTextFormatDefaults).fail(function (error) {
                setError(error && error.message
                    ? 'Formatting preference could not be saved: ' + error.message
                    : 'Formatting preference could not be saved.');
            });
        }
    }

    function textCharacterCount(value) {
        return Array.from(value).length;
    }

    function initialsFor(name) {
        var parts = safeText(name).trim().split(/\s+/).filter(Boolean);
        if (!parts.length) {
            return '—';
        }
        return parts.slice(0, 2).map(function (part) {
            return part.charAt(0).toLocaleUpperCase();
        }).join('');
    }

    function formatDate(value) {
        if (!value) {
            return 'Not set';
        }
        var date = new Date(value.length === 10 ? value + 'T00:00:00' : value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }

        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }).format(date);
    }

    function localDateKey(date) {
        return date.getFullYear()
            + '-'
            + String(date.getMonth() + 1).padStart(2, '0')
            + '-'
            + String(date.getDate()).padStart(2, '0');
    }

    function localTimezone() {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    }

    function formatDueDateTime(date, time) {
        if (!date) {
            return 'Not set';
        }
        return formatDate(date) + (time ? ' at ' + time : '');
    }

    function updateReminderAvailability() {
        var hasDueTime = !!($dueTime && $dueTime.val());
        var canSelectReminder = hasDueTime && mode !== 'view' && !requestPending;
        $reminderMinutes.prop('disabled', !canSelectReminder);
        if (!hasDueTime) {
            $reminderMinutes.val('');
        } else {
            var timezone = mode === 'edit'
                && currentTask
                && $dueDate.val() === currentTask.due_date
                && $dueTime.val() === currentTask.due_time
                ? (currentTask.due_timezone || localTimezone())
                : localTimezone();
            $('#reminder-local-time-notice').text(
                'Times use ' + timezone + '. Reminders are checked while this page is open; they cannot be delivered if the browser is closed.'
            );
        }
        $('#reminder-local-time-notice').toggleClass('hidden', !hasDueTime);
        if (window.TaskDropdowns) {
            window.TaskDropdowns.refresh('#task-reminder-minutes');
        }
    }

    function requestReminderPermission() {
        if (!('Notification' in window)) {
            $('#reminder-status').text('This browser does not support notifications. Reminders will appear only while the board is open.');
            return;
        }
        if (Notification.permission === 'granted') {
            $('#reminder-status').text('Browser notifications are enabled. Keep this page open for reminders.');
            return;
        }
        if (Notification.permission === 'denied') {
            $('#reminder-status').text('Browser notifications are blocked. Reminders can only appear in the board while it is open.');
            return;
        }
        Notification.requestPermission().then(function (permission) {
            $('#reminder-status').text(permission === 'granted'
                ? 'Browser notifications are enabled. Keep this page open for reminders.'
                : 'Notification permission was not granted. Reminders can only appear in the board while it is open.');
        }).catch(function () {
            $('#reminder-status').text('Could not request notification permission. Reminders can only appear in the board while it is open.');
        });
    }

    function formatCommentDate(value) {
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return value;
        }
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(date);
    }

    function createElement(tag, className, text) {
        var $element = $('<' + tag + '>');
        if (className) {
            $element.addClass(className);
        }
        if (text !== undefined) {
            $element.text(safeText(text));
        }
        return $element;
    }

    function icon(name, className) {
        return $('<i>').attr('data-lucide', name).addClass(className || 'h-4 w-4');
    }

    function renderIcons(context) {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons({ root: context || document });
        }
    }

    function setError(message) {
        var $region = $('#drawer-error');

        if (!$region.length) {
            $region = $('<div>', {
                id: 'drawer-error',
                role: 'alert',
                'aria-live': 'assertive'
            }).addClass('form-status is-error mb-4');
            $content.prepend($region);
        }

        $region.text(safeText(message)).removeClass('hidden');
        if (typeof $region[0].scrollIntoView === 'function') {
            $region[0].scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
        }
    }

    function clearError() {
        $('#drawer-error').remove();
        $('.field-error').remove();
        $form.find('[aria-invalid="true"]').removeAttr('aria-invalid aria-describedby');
    }

    function setFieldError(field, message) {
        var $field = $form.find('[name="' + field + '"]');
        if (!$field.length) {
            setError(message);
            return;
        }

        $field.attr('aria-invalid', 'true');
        var errorId = 'error-' + field.replace(/[^a-z0-9_-]/gi, '-');
        var $visibleDropdown = $field.hasClass('custom-dropdown-source')
            ? $field.next('.custom-dropdown-trigger')
            : $();
        if ($visibleDropdown.length) {
            $visibleDropdown.attr({
                'aria-invalid': 'true',
                'aria-describedby': errorId
            });
        } else {
            $field.attr('aria-describedby', errorId);
        }
        $('<p>', {
            id: errorId,
            role: 'alert'
        }).addClass('field-error').text(message).insertAfter($visibleDropdown.length
            ? $visibleDropdown
            : ($field.closest('.relative').length ? $field.closest('.relative') : $field));
    }

    function openState() {
        if (!$drawer || !$drawer.length) {
            return;
        }

        mode = mode === 'closed' ? 'view' : mode;
        $drawer.removeClass('is-closed').addClass('is-open');
        $drawer.attr('aria-hidden', 'false').prop('inert', false);
        $overlay.attr('aria-hidden', 'false');
        $overlay.addClass('is-visible').removeClass('hidden');

        if (mode !== 'trash' && !scrollLocked) {
            bodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            scrollLocked = true;
        }
    }

    function closeDrawer(restoreFocus, force) {
        if (!$drawer || !$drawer.length || mode === 'closed') {
            return;
        }
        if (requestPending && force !== true) {
            return;
        }

        mode = 'closed';
        $drawer.removeClass('is-open').addClass('is-closed');
        $drawer.attr('aria-hidden', 'true').prop('inert', true);
        $overlay.removeClass('is-visible').addClass('hidden').attr('aria-hidden', 'true');
        if (scrollLocked) {
            document.body.style.overflow = bodyOverflow;
            scrollLocked = false;
        }

        currentTask = null;
        $content.children('.task-view, .tag-editor, #task-comments-panel').remove();
        $(document).trigger('taskmanager:text-format-preview-clear');
        renderForm({
            id: '',
            title: '',
            description: '',
            status: 'todo',
            priority: 'medium',
            assignee: '',
            due_date: '',
            tags: []
        }, true);
        setFooterForMode('closed');
        $heading.text('Task Details');
        $deleteButton.hide();
        $commentsTab.find('#comment-count').text('0');
        setActiveTab('details');

        if (restoreFocus !== false && lastFocus && document.contains(lastFocus)) {
            lastFocus.focus();
        }
    }

    function rememberFocus() {
        var active = document.activeElement;
        if (active && !$drawer[0].contains(active)) {
            lastFocus = active;
        }
    }

    function findCachedTask(taskId) {
        var globalTask = null;
        if (window.TaskApp && typeof window.TaskApp.getTaskById === 'function') {
            globalTask = window.TaskApp.getTaskById(taskId);
        }
        if (globalTask) {
            return globalTask;
        }

        return taskCache.find(function (task) {
            return task.id === taskId;
        }) || null;
    }

    function loadTask(taskId) {
        if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(taskId)) {
            return $.Deferred().reject(new Error('A valid task ID is required.')).promise();
        }

        var task = findCachedTask(taskId);
        if (task) {
            return $.Deferred().resolve(task).promise();
        }

        if (!window.TaskStorage || typeof window.TaskStorage.listTasks !== 'function') {
            return $.Deferred().reject(new Error('Task data is not available.')).promise();
        }

        return window.TaskStorage.listTasks().then(function (tasks) {
            if (!Array.isArray(tasks)) {
                throw new Error('The task list could not be loaded.');
            }
            taskCache = tasks.slice();
            var loadedTask = findCachedTask(taskId);
            if (!loadedTask) {
                throw new Error('The requested task could not be found.');
            }
            return loadedTask;
        });
    }

    function cacheTask(task) {
        if (!task || typeof task.id !== 'string') {
            return;
        }
        var index = taskCache.findIndex(function (cached) {
            return cached.id === task.id;
        });
        if (index === -1) {
            taskCache.push(task);
        } else {
            taskCache[index] = task;
        }
    }

    function buildView(task) {
        var $view = $('<div>', { class: 'task-view space-y-5' });
        var $titleBlock = $('<section>');
        $titleBlock.append(createElement('p', 'mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400', 'Title'));
        $titleBlock.append(createElement('h3', 'break-words text-lg font-bold text-slate-900', formattedText(task.title, 'title', task.text_format)));
        $view.append($titleBlock);

        var $descriptionBlock = $('<section>');
        $descriptionBlock.append(createElement('p', 'mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400', 'Description'));
        $descriptionBlock.append(createElement('p', 'whitespace-pre-wrap break-words text-sm leading-6 text-slate-600', task.description
            ? formattedText(task.description, 'description', task.text_format)
            : 'No description provided.'));
        $view.append($descriptionBlock);

        var $metadata = $('<dl>', { class: 'grid grid-cols-2 gap-4' });
        [
            ['Status', statusLabels[task.status] || statusLabels.todo],
            ['Priority', priorityLabels[task.priority] || priorityLabels.medium],
            ['Assignee', task.assignee || 'Unassigned'],
            ['Due date', formatDueDateTime(task.due_date, task.due_time)],
            ['Reminder', task.reminder_minutes === 5 || task.reminder_minutes === 10
                ? task.reminder_minutes + ' minutes before'
                : 'No reminder']
        ].forEach(function (item) {
            var $item = $('<div>');
            $item.append(createElement('dt', 'mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400', item[0]));
            var $value = createElement('dd', 'text-sm font-medium text-slate-700', item[1]);
            if (item[0] === 'Assignee' && task.assignee) {
                $value.empty().addClass('flex items-center gap-2');
                $value.append(createElement('span', 'assignee-avatar', initialsFor(task.assignee)));
                $value.append(createElement('span', '', task.assignee));
            }
            $item.append($value);
            $metadata.append($item);
        });
        $view.append($metadata);

        var $tagsSection = $('<section>');
        $tagsSection.append(createElement('p', 'mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400', 'Tags'));
        var $tagList = $('<div>', { class: 'flex flex-wrap gap-2' });
        if (Array.isArray(task.tags) && task.tags.length) {
            task.tags.forEach(function (tag) {
                $tagList.append(createElement('span', 'tag-pill', tag));
            });
        } else {
            $tagList.append(createElement('span', 'text-sm text-slate-400', 'No tags'));
        }
        $tagsSection.append($tagList);
        $view.append($tagsSection);

        var $dates = $('<section>', { class: 'border-t border-slate-100 pt-4' });
        $dates.append(createElement('p', 'text-xs text-slate-500', 'Created ' + formatDate(task.created_at)));
        $dates.append(createElement('p', 'mt-1 text-xs text-slate-500', 'Last updated ' + formatDate(task.updated_at)));
        $view.append($dates);

        return $view;
    }

    function setActiveTab(tab) {
        var commentsActive = tab === 'comments';
        $detailsTab
            .toggleClass('is-active', !commentsActive)
            .attr('aria-selected', commentsActive ? 'false' : 'true')
            .attr('tabindex', commentsActive ? '-1' : '0');
        $commentsTab
            .toggleClass('is-active', commentsActive)
            .attr('aria-selected', commentsActive ? 'true' : 'false')
            .attr('tabindex', commentsActive ? '0' : '-1')
            .attr('aria-label', 'Comments, ' + ($commentsTab.find('#comment-count').text() || '0') + ' comments')
            .prop('disabled', mode === 'add' || mode === 'closed');

        if (commentsActive) {
            $form.hide();
            $content.children('.task-view').hide();
            $content.children('#task-comments-panel').show();
        } else {
            $content.children('#task-comments-panel').hide();
            if (mode === 'view') {
                $form.hide();
                $content.children('.task-view').show();
            } else if (mode !== 'closed') {
                $content.children('.task-view').hide();
                $form.show();
            }
        }
    }

    function renderCommentsPanel(task) {
        var comments = Array.isArray(task.comments) ? task.comments : [];
        var $panel = $('<section>', {
            id: 'task-comments-panel',
            class: 'task-comments-panel space-y-4',
            'aria-label': 'Task comments'
        });
        var $list = $('<div>', {
            class: 'task-comment-list space-y-3',
            'aria-live': 'polite'
        });

        if (!comments.length) {
            var $empty = $('<div>', { class: 'comments-empty' });
            $empty.append(icon('message-square', 'mb-2 h-6 w-6'));
            $empty.append(createElement('p', 'font-semibold text-slate-700', 'No comments yet'));
            $empty.append(createElement('p', 'mt-1 text-xs text-slate-500', 'Add a comment to start the conversation.'));
            $list.append($empty);
        } else {
            comments.forEach(function (comment) {
                var $item = $('<article>', {
                    class: 'task-comment',
                    'data-comment-id': comment.id
                });
                var $header = $('<div>', { class: 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1' });
                $header.append(createElement('strong', 'text-sm font-semibold text-slate-800', comment.author));
                $header.append(createElement('time', 'text-xs text-slate-400', formatCommentDate(comment.created_at))
                    .attr('datetime', comment.created_at));
                $item.append($header);
                $item.append(createElement('p', 'mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600', comment.message));
                $list.append($item);
            });
        }

        var $formWrap = $('<form>', {
            id: 'comment-form',
            class: 'comment-form border-t border-slate-100 pt-4'
        });
        $formWrap.append(createElement('label', 'mb-1.5 block text-xs font-medium text-slate-700', 'Add a comment')
            .attr('for', 'comment-input'));
        $formWrap.append($('<textarea>', {
            id: 'comment-input',
            name: 'message',
            rows: 4,
            required: true,
            placeholder: 'Write a comment...'
        }).addClass('w-full resize-y rounded-lg border border-slate-200 px-3 py-2.5 text-sm leading-5 text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-400 focus:ring-4 focus:ring-slate-100'));
        var $formFooter = $('<div>', { class: 'mt-2 flex items-center justify-between gap-3' });
        $formFooter.append(createElement('span', 'text-xs text-slate-400', 'Comments are saved with this task.'));
        $formFooter.append($('<button>', {
            id: 'submit-comment',
            type: 'submit'
        }).addClass('inline-flex items-center gap-2 rounded-lg bg-slate-950 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800')
            .append(icon('send', 'h-3.5 w-3.5'))
            .append(document.createTextNode('Add comment')));
        $formWrap.append($formFooter);
        $panel.append($list, $formWrap);
        $content.children('#task-comments-panel').remove();
        $content.append($panel);
        $commentsTab.find('#comment-count').text(comments.length);
        $commentsTab.attr('aria-label', 'Comments, ' + comments.length + ' comments');
        renderIcons($panel[0]);
    }

    function setEditable(editable) {
        $form.find(':input').prop('disabled', !editable);
        $form.find('.text-format-button').prop('disabled', !editable);
        $form.attr('aria-readonly', editable ? 'false' : 'true');
        $('#add-tag').prop('disabled', !editable);
        $tags.find('.remove-tag').prop('disabled', !editable);
    }

    function populateAssignees(selected) {
        $assignee.empty();
        $assignee.append($('<option>', { value: '' }).text('Unassigned'));

        var options = assignees.slice();
        if (selected && options.indexOf(selected) === -1) {
            options.push(selected);
        }
        options.forEach(function (name) {
            $assignee.append($('<option>', { value: name }).text(name));
        });
        $assignee.val(selected || '');
    }

    function renderTags(tags, editable) {
        $tags.empty();
        (Array.isArray(tags) ? tags : []).forEach(function (tag) {
            var $pill = $('<span>', { class: 'tag-pill', 'data-tag': tag });
            $pill.append(document.createTextNode(tag));
            if (editable) {
                var $remove = $('<button>', {
                    type: 'button',
                    class: 'remove-tag',
                    'aria-label': 'Remove ' + tag + ' tag'
                });
                $remove.append(icon('x', 'h-3 w-3'));
                $pill.append($remove);
            }
            $tags.append($pill);
        });
        renderIcons($tags[0]);
    }

    function renderForm(task, editable) {
        $content.children().not('#task-form').remove();
        if (!$form.parent().is($content)) {
            $content.append($form);
        }
        $form.show().removeAttr('aria-hidden');

        $taskId.val(task.id || '');
        $title.val(task.title || '');
        $description.val(task.description || '');
        renderTextFormatControls(task.text_format || (mode === 'add' ? globalTextFormatDefaults : window.TaskStorage.defaultTextFormat));
        $status.val(task.status || 'todo');
        $priority.val(task.priority || 'medium');
        populateAssignees(task.assignee || '');
        $dueDate.val(task.due_date || '');
        $dueTime.val(task.due_time || '');
        $reminderMinutes.val(task.reminder_minutes == null ? '' : String(task.reminder_minutes));
        $('#reminder-status').text('');
        renderTags(task.tags || [], editable);
        setEditable(editable);
        updateReminderAvailability();
        if (window.TaskDropdowns) {
            window.TaskDropdowns.refresh('#task-status, #task-priority, #task-assignee');
        }
        clearError();
    }

    function setFooterForMode(nextMode) {
        $saveButton.removeClass('is-saving').prop('disabled', false);
        $deleteButton.prop('disabled', false);
        $cancelButton.text(nextMode === 'view' ? 'Close' : 'Cancel');

        if (nextMode === 'add') {
            $heading.text('Add Task');
            $saveButton.text('Save Task').show();
            $deleteButton.hide();
            return;
        }
        if (nextMode === 'view') {
            $heading.text('Task Details');
            $saveButton.text('Edit').show();
            $deleteButton.show();
            return;
        }
        $heading.text('Edit Task');
        $saveButton.text('Save Changes').show();
        $deleteButton.show();
    }

    function prepareOpen(nextMode) {
        refreshElements();
        if (!$drawer.length || !$content.length || !$form.length) {
            throw new Error('Task drawer markup is incomplete.');
        }
        if (mode === 'closed' || mode === 'trash') {
            rememberFocus();
        }
        $(document).trigger('taskmanager:drawer-opening');
        mode = nextMode;
        openState();
        setFooterForMode(nextMode);
    }

    function openAdd(status) {
        prepareOpen('add');
        currentTask = null;
        var task = {
            id: '',
            title: '',
            description: '',
            status: Object.prototype.hasOwnProperty.call(statusLabels, status) ? status : 'todo',
            priority: 'medium',
            assignee: assignees[0] || '',
            due_date: localDateKey(new Date()),
            due_time: '',
            reminder_minutes: null,
            due_timezone: '',
            tags: [],
            text_format: $.extend({}, globalTextFormatDefaults)
        };
        renderForm(task, true);
        $commentsTab.find('#comment-count').text('0');
        setActiveTab('details');
        window.setTimeout(function () {
            if (mode === 'add') {
                $title.trigger('focus');
            }
        }, 20);
    }

    function openView(taskId) {
        return loadTask(taskId).then(function (task) {
            currentTask = task;
            prepareOpen('view');
            setEditable(false);
            $content.children('.task-view, #task-comments-panel').remove();
            $form.hide().attr('aria-hidden', 'true');
            $content.prepend(buildView(task));
            renderCommentsPanel(task);
            setActiveTab('details');
            clearError();
            $saveButton.text('Edit').show();
            $deleteButton.show();
            renderIcons($content[0]);
            window.setTimeout(function () {
                if (mode === 'view') {
                    $saveButton.trigger('focus');
                }
            }, 20);
            return task;
        }).catch(function (error) {
            if (mode === 'closed') {
                prepareOpen('view');
            }
            setError(error && error.message ? error.message : 'Unable to open task details.');
            throw error;
        });
    }

    function openEdit(taskId) {
        return loadTask(taskId).then(function (task) {
            currentTask = task;
            prepareOpen('edit');
            setFooterForMode('edit');
            renderForm(task, true);
            renderCommentsPanel(task);
            setActiveTab('details');
            window.setTimeout(function () {
                if (mode === 'edit') {
                    $title.trigger('focus');
                }
            }, 20);
            return task;
        }).catch(function (error) {
            if (mode !== 'closed') {
                setError(error && error.message ? error.message : 'Unable to edit this task.');
            }
            throw error;
        });
    }

    function formData() {
        var dueDate = $dueDate.val() || '';
        var dueTime = $dueTime.val() || '';
        var dueTimezone = '';
        if (dueTime) {
            dueTimezone = mode === 'edit'
                && currentTask
                && dueDate === currentTask.due_date
                && dueTime === currentTask.due_time
                ? (currentTask.due_timezone || localTimezone())
                : localTimezone();
        }
        return {
            title: $.trim($title.val() || ''),
            description: $.trim($description.val() || ''),
            status: $status.val(),
            priority: $priority.val(),
            assignee: $assignee.val() || '',
            due_date: dueDate,
            due_time: dueTime,
            reminder_minutes: $reminderMinutes.val() === '' ? null : Number($reminderMinutes.val()),
            due_timezone: dueTimezone,
            text_format: $.extend({}, activeTextFormat),
            tags: $tags.find('.tag-pill').map(function () {
                return $(this).attr('data-tag');
            }).get()
        };
    }

    function validateForm(data) {
        clearError();
        var valid = true;
        if (!data.title) {
            setFieldError('title', 'Enter a task title.');
            valid = false;
        } else if (data.title.length > 160) {
            setFieldError('title', 'Title must be 160 characters or fewer.');
            valid = false;
        }
        if (data.description.length > 5000) {
            setFieldError('description', 'Description must be 5000 characters or fewer.');
            valid = false;
        }
        if (data.due_time && !data.due_date) {
            setFieldError('due_time', 'Choose a due date before setting a due time.');
            valid = false;
        }
        if (data.reminder_minutes !== null) {
            var dateParts = data.due_date.split('-').map(Number);
            var timeParts = data.due_time.split(':').map(Number);
            var deadline = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1]);
            if (
                !data.due_time
                || !data.due_date
                || deadline.getFullYear() !== dateParts[0]
                || deadline.getMonth() !== dateParts[1] - 1
                || deadline.getDate() !== dateParts[2]
                || deadline.getHours() !== timeParts[0]
                || deadline.getMinutes() !== timeParts[1]
                || deadline.getTime() <= Date.now()
            ) {
                setFieldError('reminder_minutes', 'Choose a future due date and time for reminders.');
                valid = false;
            }
        }
        if (!Object.prototype.hasOwnProperty.call(statusLabels, data.status)) {
            setFieldError('status', 'Choose a valid status.');
            valid = false;
        }
        if (!Object.prototype.hasOwnProperty.call(priorityLabels, data.priority)) {
            setFieldError('priority', 'Choose a valid priority.');
            valid = false;
        }
        if (data.tags.some(function (tag) {
            return !tag || tag.length > 40;
        })) {
            setError('Tags must contain between 1 and 40 characters.');
            valid = false;
        }
        return valid;
    }

    function setPending(pending) {
        requestPending = pending;
        $saveButton.prop('disabled', pending).toggleClass('is-saving', pending);
        $deleteButton.prop('disabled', pending);
        $cancelButton.prop('disabled', pending);
        $form.find(':input').prop('disabled', pending || mode === 'view');
        $form.find('.text-format-button').prop('disabled', pending || mode === 'view');
        updateReminderAvailability();
    }

    function notifyChange(action, task) {
        $(document).trigger('taskmanager:changed', [{
            action: action,
            task: task || null
        }]);
    }

    function saveTask(event) {
        if (event) {
            event.preventDefault();
        }
        if (requestPending) {
            return;
        }

        if (mode === 'view') {
            if (currentTask) {
                openEdit(currentTask.id).fail(function () {});
            }
            return;
        }

        if (mode !== 'add' && mode !== 'edit') {
            return;
        }

        var data = formData();
        if (!validateForm(data)) {
            return;
        }
        if (!window.TaskStorage) {
            setError('Task storage is unavailable. Reload the page and try again.');
            return;
        }

        setPending(true);
        var operation = mode === 'add'
            ? window.TaskStorage.createTask(data)
            : window.TaskStorage.updateTask(currentTask.id, data);
        var completedMode = mode;

        operation.done(function (task) {
            cacheTask(task);
            currentTask = task;
            notifyChange(completedMode === 'add' ? 'created' : 'updated', task);
            closeDrawer(true, true);
        }).fail(function (error) {
            setError(error && error.message ? error.message : 'Could not save this task. Your changes are still here.');
        }).always(function () {
            setPending(false);
            if (mode !== 'closed') {
                setFooterForMode(mode);
            }
        });
    }

    function deleteTask() {
        if (requestPending || !currentTask || !window.TaskStorage) {
            return;
        }
        if (!window.confirm('Move "' + formattedText(currentTask.title, 'title', currentTask.text_format) + '" to Trash?')) {
            return;
        }

        setPending(true);
        window.TaskStorage.softDeleteTask(currentTask.id).done(function (task) {
            cacheTask(task);
            notifyChange('soft_deleted', task);
            closeDrawer(true, true);
        }).fail(function (error) {
            setError(error && error.message ? error.message : 'Could not move this task to Trash.');
        }).always(function () {
            setPending(false);
        });
    }

    function submitComment(event) {
        if (event) {
            event.preventDefault();
        }
        if (commentRequestPending || !currentTask || mode === 'closed' || mode === 'add') {
            return;
        }
        var $input = $('#comment-input');
        var message = ($input.val() || '').trim();
        $('#comment-error').remove();
        if (!message) {
            $('<p>', {
                id: 'comment-error',
                role: 'alert',
                'aria-live': 'assertive'
            }).addClass('comment-error').text('Enter a comment before submitting.')
                .insertAfter($input);
            $input.trigger('focus');
            return;
        }
        if (textCharacterCount(message) > 5000) {
            $('<p>', {
                id: 'comment-error',
                role: 'alert',
                'aria-live': 'assertive'
            }).addClass('comment-error').text('Comments must be 5000 characters or fewer.')
                .insertAfter($input);
            $input.trigger('focus');
            return;
        }
        if (!window.TaskStorage || typeof window.TaskStorage.addTaskComment !== 'function') {
            $('<p>', {
                id: 'comment-error',
                role: 'alert',
                'aria-live': 'assertive'
            }).addClass('comment-error').text('Comment storage is unavailable. Reload the page and try again.')
                .insertAfter($input);
            return;
        }

        var taskId = currentTask.id;
        commentRequestPending = true;
        $('#submit-comment').prop('disabled', true).addClass('is-saving');
        $input.prop('disabled', true);
        window.TaskStorage.addTaskComment(taskId, message).done(function (task) {
            cacheTask(task);
            if (currentTask && currentTask.id === taskId) {
                currentTask = task;
                if (mode !== 'closed' && $('#task-comments-panel').length) {
                    $('#comment-input').val('');
                    renderCommentsPanel(task);
                    setActiveTab('comments');
                }
            }
            notifyChange('comment_added', task);
        }).fail(function (error) {
            var messageText = error && error.message
                ? error.message
                : 'Could not save this comment. Your text is still here.';
            if (currentTask && currentTask.id === taskId && $('#comment-input').length) {
                $('<p>', {
                    id: 'comment-error',
                    role: 'alert',
                    'aria-live': 'assertive'
                }).addClass('comment-error').text(messageText).insertAfter($('#comment-input'));
            }
        }).always(function () {
            commentRequestPending = false;
            if (currentTask && currentTask.id === taskId && $('#comment-input').length) {
                $('#comment-input').prop('disabled', false);
                $('#submit-comment').prop('disabled', false).removeClass('is-saving');
            }
        });
    }

    function showTagEditor() {
        if (mode === 'view' || mode === 'closed' || requestPending) {
            return;
        }

        if ($('#new-tag-input').length) {
            $('#new-tag-input').trigger('focus');
            return;
        }

        var $editor = $('<div>', {
            class: 'tag-editor mt-3 flex w-full items-center gap-2'
        });
        var $input = $('<input>', {
            id: 'new-tag-input',
            type: 'text',
            maxlength: 40,
            autocomplete: 'off',
            'aria-label': 'New tag name',
            placeholder: 'Enter a tag'
        }).addClass('h-9 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-xs outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100');
        var $add = $('<button>', {
            id: 'confirm-add-tag',
            type: 'button'
        }).addClass('rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700').text('Add');
        var $cancel = $('<button>', {
            id: 'cancel-add-tag',
            type: 'button',
            'aria-label': 'Cancel adding tag'
        }).addClass('rounded-lg p-2 text-slate-500 hover:bg-slate-100').append(icon('x', 'h-4 w-4'));

        $editor.append($input, $add, $cancel);
        $tags.after($editor);
        renderIcons($editor[0]);
        $input.trigger('focus');
    }

    function commitTag() {
        var $input = $('#new-tag-input');
        if (!$input.length || mode === 'view' || requestPending) {
            return;
        }

        var tag = $.trim($input.val() || '');
        clearError();
        if (!tag) {
            setError('A tag cannot be empty.');
            $input.trigger('focus');
            return;
        }
        if (tag.length > 40) {
            setError('Tags must be 40 characters or fewer.');
            $input.trigger('focus');
            return;
        }
        var tags = $tags.find('.tag-pill').map(function () {
            return $(this).attr('data-tag');
        }).get();
        if (tags.some(function (existing) {
            return existing.toLocaleLowerCase() === tag.toLocaleLowerCase();
        })) {
            setError('That tag has already been added.');
            $input.trigger('focus');
            return;
        }
        tags.push(tag);
        $('.tag-editor').remove();
        clearError();
        renderTags(tags, true);
    }

    function bindEvents() {
        $(document)
            .off('.taskDrawer')
            .on('click.taskDrawer', '#add-task, .quick-add', function (event) {
                event.preventDefault();
                var status = $(this).attr('data-status') || 'todo';
                openAdd(status);
            })
            .on('click.taskDrawer', '.task-card', function (event) {
                if ($(event.target).closest('button, a, input, select, textarea, .task-selection').length) {
                    return;
                }
                var taskId = $(this).attr('data-task-id');
                if (taskId) {
                    openView(taskId).fail(function () {});
                }
            })
            .on('keydown.taskDrawer', '.task-card', function (event) {
                if ((event.key === 'Enter' || event.key === ' ')
                    && !$(event.target).closest('button, input, select, textarea, label').length) {
                    event.preventDefault();
                    var taskId = $(this).attr('data-task-id');
                    if (taskId) {
                        openView(taskId).fail(function () {});
                    }
                }
            })
            .on('click.taskDrawer', '#close-drawer, #cancel-drawer', function () {
                closeDrawer(true);
            })
            .on('click.taskDrawer', '#drawer-overlay', function (event) {
                if (event.target === this) {
                    closeDrawer(true);
                }
            })
            .on('click.taskDrawer', '#save-task', saveTask)
            .on('submit.taskDrawer', '#task-form', saveTask)
            .on('click.taskDrawer', '#task-details-tab', function () {
                setActiveTab('details');
            })
            .on('click.taskDrawer', '#task-comments-tab', function () {
                if (!currentTask || mode === 'add' || mode === 'closed') {
                    return;
                }
                if (!$('#task-comments-panel').length) {
                    renderCommentsPanel(currentTask);
                }
                setActiveTab('comments');
            })
            .on('click.taskDrawer', '.text-format-button', function () {
                if (requestPending || mode === 'view' || mode === 'closed') {
                    return;
                }
                changeTextFormat($(this).attr('data-format-field'), $(this).attr('data-format-mode'));
            })
            .on('input.taskDrawer', '#task-title, #task-description', updateTextPreviews)
            .on('submit.taskDrawer', '#comment-form', submitComment)
            .on('input.taskDrawer', '#comment-input', function () {
                $('#comment-error').remove();
            })
            .on('click.taskDrawer', '#delete-task', deleteTask)
            .on('click.taskDrawer', '#clear-due-date', function () {
                if (mode !== 'view' && !requestPending) {
                    $dueDate.val('').trigger('change');
                    $dueTime.val('');
                    $reminderMinutes.val('');
                    updateReminderAvailability();
                }
            })
            .on('change.taskDrawer', '#task-due-date', function () {
                if (!$(this).val()) {
                    $dueTime.val('');
                    $reminderMinutes.val('');
                }
                updateReminderAvailability();
            })
            .on('change.taskDrawer', '#task-due-time', updateReminderAvailability)
            .on('change.taskDrawer', '#task-reminder-minutes', function () {
                if ($(this).val()) {
                    requestReminderPermission();
                } else {
                    $('#reminder-status').text('');
                }
            })
            .on('click.taskDrawer', '#add-tag', showTagEditor)
            .on('click.taskDrawer', '#confirm-add-tag', commitTag)
            .on('click.taskDrawer', '#cancel-add-tag', function () {
                $('.tag-editor').remove();
            })
            .on('keydown.taskDrawer', '#new-tag-input', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitTag();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    $('.tag-editor').remove();
                    $('#add-tag').trigger('focus');
                }
            })
            .on('click.taskDrawer', '.remove-tag', function () {
                if (mode === 'view' || requestPending) {
                    return;
                }
                $(this).closest('.tag-pill').remove();
            })
            .on('input.taskDrawer change.taskDrawer', '#task-form :input', function () {
                var name = $(this).attr('name');
                if (name) {
                    $(this).removeAttr('aria-invalid aria-describedby');
                    $('#error-' + name.replace(/[^a-z0-9_-]/gi, '-')).remove();
                }
                $('#drawer-error').remove();
            })
            .on('keydown.taskDrawer', function (event) {
                if (event.key === 'Escape' && mode !== 'closed') {
                    event.preventDefault();
                    closeDrawer(true);
                }
                if (event.key === 'Tab' && mode !== 'closed' && $drawer.length) {
                    var focusable = $drawer.find('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
                        .filter(':visible');
                    if (!focusable.length) {
                        event.preventDefault();
                        $drawer.trigger('focus');
                        return;
                    }
                    var first = focusable[0];
                    var last = focusable[focusable.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }
            });
    }

    function initialize() {
        refreshElements();
        if (!$drawer.length) {
            return;
        }

        reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        taskCache = Array.isArray(window.initialTasks) ? window.initialTasks.slice() : [];
        taskCache = taskCache.filter(function (task) {
            return task && typeof task.id === 'string';
        });
        if (window.TaskApp && typeof window.TaskApp.getTasks === 'function') {
            var appTasks = window.TaskApp.getTasks();
            if (Array.isArray(appTasks)) {
                taskCache = appTasks.slice();
            }
        }

        $drawer.attr({
            'aria-hidden': 'true',
            'aria-modal': 'true',
            tabindex: '-1'
        }).prop('inert', true).addClass('is-closed').removeClass('is-open');
        $overlay.attr('aria-hidden', 'true').removeClass('is-visible').addClass('hidden');
        $('#trash-drawer').attr('aria-hidden', 'true').prop('inert', true);
        $deleteButton.hide();
        $saveButton.show();
        populateAssignees('');
        bindEvents();

        $(document).on('taskmanager:tasks-loaded.taskDrawer', function (event, tasks) {
            if (Array.isArray(tasks)) {
                taskCache = tasks.slice();
            }
        });

        $(document).on('focusin.taskDrawer', function (event) {
            if (mode !== 'closed' && $drawer.length && !$drawer[0].contains(event.target)) {
                var $first = $drawer.find('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])').filter(':visible').first();
                if ($first.length) {
                    $first.trigger('focus');
                }
            }
        });

        mode = 'closed';
    }

    var TaskDrawer = {
        openAdd: openAdd,
        openView: openView,
        openEdit: openEdit,
        close: function (restoreFocus) {
            closeDrawer(restoreFocus !== false);
        },
        refresh: function (taskId) {
            if (taskId) {
                taskCache = taskCache.filter(function (task) {
                    return task.id !== taskId;
                });
            }
            if (mode === 'view' && currentTask && (!taskId || taskId === currentTask.id)) {
                return openView(currentTask.id);
            }
            return $.Deferred().resolve(null).promise();
        },
        setTasks: function (tasks) {
            if (!Array.isArray(tasks)) {
                throw new TypeError('TaskDrawer.setTasks expects an array.');
            }
            taskCache = tasks.slice();
        },
        getMode: function () {
            return mode;
        }
    };

    window.TaskDrawer = Object.freeze(TaskDrawer);
    $(initialize);
}(window.jQuery, window, document));
