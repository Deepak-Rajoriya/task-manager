(function ($, window) {
    'use strict';

    if (!$ || typeof $.ajax !== 'function') {
        throw new Error('TaskStorage requires jQuery to be loaded first.');
    }

    var statuses = ['todo', 'in_progress', 'review', 'done'];
    var priorities = ['low', 'medium', 'high'];
    var editableFields = [
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
        'text_format'
    ];
    var defaultTextFormat = Object.freeze({
        title: 'capital_case',
        description: 'sentence_case'
    });
    var textFormatModes = ['uppercase', 'capital_case', 'sentence_case'];
    var textFormatDefaultsSaveQueue = $.Deferred().resolve().promise();

    function createError(message, details) {
        var error = new Error(message);

        if (details) {
            error.status = details.status || 0;
            error.code = details.code || '';
            error.response = details.response || null;
        }

        return error;
    }

    function endpointUrl(action) {
        var url = new URL(window.location.href);

        url.searchParams.set('ajax', '1');
        if (action) {
            url.searchParams.set('action', action);
        }
        url.hash = '';

        return url.toString();
    }

    function csrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return (window.TASK_MANAGER_CSRF_TOKEN || (meta && meta.content) || '').trim();
    }

    function request(method, action, payload) {
        var headers = {
            Accept: 'application/json'
        };
        var token = csrfToken();

        if (token) {
            headers['X-CSRF-Token'] = token;
        }

        return $.ajax({
            url: endpointUrl(method === 'GET' ? action : ''),
            method: method,
            data: method === 'GET' ? undefined : JSON.stringify(payload),
            contentType: method === 'GET' ? undefined : 'application/json; charset=UTF-8',
            dataType: 'json',
            processData: false,
            headers: headers
        }).then(
            function (response) {
                if (
                    !response
                    || typeof response !== 'object'
                    || Array.isArray(response)
                    || typeof response.success !== 'boolean'
                ) {
                    throw createError('The task server returned an invalid response.');
                }

                if (!response.success) {
                    throw createError(
                        typeof response.message === 'string' && response.message
                            ? response.message
                            : 'The task request was rejected by the server.',
                        { response: response, code: 'server_rejected' }
                    );
                }

                if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
                    throw createError('The task server returned an invalid response payload.');
                }

                return response.data;
            },
            function (xhr, textStatus) {
                var response = xhr && xhr.responseJSON;

                if (!response && xhr && typeof xhr.responseText === 'string' && xhr.responseText !== '') {
                    try {
                        response = JSON.parse(xhr.responseText);
                    } catch (parseError) {
                        response = null;
                    }
                }

                if (
                    response
                    && typeof response === 'object'
                    && typeof response.message === 'string'
                    && response.message
                ) {
                    throw createError(response.message, {
                        status: xhr.status,
                        code: 'http_error',
                        response: response
                    });
                }

                if (textStatus === 'parsererror') {
                    throw createError('The task server returned malformed JSON.', {
                        status: xhr && xhr.status,
                        code: 'invalid_json'
                    });
                }

                throw createError(
                    xhr && xhr.status
                        ? 'Task request failed with HTTP ' + xhr.status + '.'
                        : 'Could not reach the task server. Check your connection and try again.',
                    {
                        status: xhr && xhr.status,
                        code: 'network_error'
                    }
                );
            }
        );
    }

    function normalizeTask(task) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) {
            throw createError('The task server returned an invalid task.');
        }

        if (typeof task.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(task.id)) {
            throw createError('The task server returned a task with an invalid ID.');
        }
        if (typeof task.title !== 'string' || task.title.trim() === '' || task.title.length > 160) {
            throw createError('The task server returned a task with an invalid title.');
        }
        if (typeof task.status !== 'string' || statuses.indexOf(task.status) === -1) {
            throw createError('The task server returned a task with an invalid status.');
        }
        if (typeof task.priority !== 'string' || priorities.indexOf(task.priority) === -1) {
            throw createError('The task server returned a task with an invalid priority.');
        }

        var normalized = {
            id: task.id,
            title: task.title,
            description: optionalString(task, 'description'),
            status: task.status,
            priority: task.priority,
            due_date: optionalString(task, 'due_date'),
            due_time: optionalString(task, 'due_time'),
            reminder_minutes: optionalReminderMinutes(task),
            due_timezone: optionalString(task, 'due_timezone'),
            assignee: optionalString(task, 'assignee'),
            tags: optionalTags(task),
            text_format: normalizeTextFormat(task.text_format),
            comments: optionalComments(task),
            deleted: optionalBoolean(task, 'deleted', false)
        };

        if (Object.prototype.hasOwnProperty.call(task, 'created_at')) {
            if (typeof task.created_at !== 'string') {
                throw createError('The task server returned an invalid creation timestamp.');
            }
            normalized.created_at = task.created_at;
        }

        if (Object.prototype.hasOwnProperty.call(task, 'updated_at')) {
            if (typeof task.updated_at !== 'string') {
                throw createError('The task server returned an invalid update timestamp.');
            }
            normalized.updated_at = task.updated_at;
        }

        if (Object.prototype.hasOwnProperty.call(task, 'completed_at')) {
            if (typeof task.completed_at !== 'string' || Number.isNaN(Date.parse(task.completed_at))) {
                throw createError('The task server returned an invalid completion timestamp.');
            }
            normalized.completed_at = task.completed_at;
        }

        return normalized;
    }

    function normalizeTextFormat(textFormat) {
        if (textFormat == null) {
            return {
                title: defaultTextFormat.title,
                description: defaultTextFormat.description
            };
        }
        if (!textFormat || typeof textFormat !== 'object' || Array.isArray(textFormat)) {
            throw createError('The task server returned invalid text formatting preferences.');
        }
        var normalized = {};
        ['title', 'description'].forEach(function (field) {
            var mode = Object.prototype.hasOwnProperty.call(textFormat, field)
                ? textFormat[field]
                : defaultTextFormat[field];
            if (typeof mode !== 'string' || textFormatModes.indexOf(mode) === -1) {
                throw createError('The task server returned invalid text formatting preferences.');
            }
            normalized[field] = mode;
        });
        return normalized;
    }

    function formatText(value, mode) {
        var text = value == null ? '' : String(value);
        if (mode === 'uppercase') {
            return text.toUpperCase();
        }
        text = text.toLowerCase();
        if (mode === 'capital_case') {
            return text.replace(/(^|[^\p{L}\p{N}])([\p{L}\p{N}])/gu, function (match, separator, letter) {
                return separator + letter.toUpperCase();
            });
        }
        if (mode === 'sentence_case') {
            return text.replace(/(^|[.!?]\s+|\n+)([^\p{L}\p{N}]*)(\p{L})/gu, function (match, boundary, punctuation, letter) {
                return boundary + punctuation + letter.toUpperCase();
            });
        }
        return text;
    }

    function optionalString(task, field) {
        if (!Object.prototype.hasOwnProperty.call(task, field)) {
            return '';
        }
        if (typeof task[field] !== 'string') {
            throw createError('The task server returned invalid task ' + field + ' data.');
        }
        return task[field];
    }

    function optionalTags(task) {
        if (!Object.prototype.hasOwnProperty.call(task, 'tags')) {
            return [];
        }
        if (!Array.isArray(task.tags) || task.tags.some(function (tag) {
            return typeof tag !== 'string';
        })) {
            throw createError('The task server returned invalid task tags.');
        }
        return task.tags.slice();
    }

    function optionalReminderMinutes(task) {
        if (!Object.prototype.hasOwnProperty.call(task, 'reminder_minutes') || task.reminder_minutes == null) {
            return null;
        }
        if (task.reminder_minutes !== 5 && task.reminder_minutes !== 10) {
            throw createError('The task server returned an invalid reminder interval.');
        }
        return task.reminder_minutes;
    }

    function optionalComments(task) {
        if (!Object.prototype.hasOwnProperty.call(task, 'comments')) {
            return [];
        }
        if (!Array.isArray(task.comments)) {
            throw createError('The task server returned an invalid task comments list.');
        }
        return task.comments.map(function (comment) {
            if (
                !comment
                || typeof comment !== 'object'
                || Array.isArray(comment)
                || typeof comment.id !== 'string'
                || !/^comment-[A-Fa-f0-9]{16,64}$/.test(comment.id)
                || typeof comment.author !== 'string'
                || !comment.author.trim()
                || typeof comment.message !== 'string'
                || !comment.message.trim()
                || Array.from(comment.message).length > 5000
                || typeof comment.created_at !== 'string'
                || Number.isNaN(Date.parse(comment.created_at))
            ) {
                throw createError('The task server returned an invalid task comment.');
            }
            return {
                id: comment.id,
                author: comment.author,
                message: comment.message,
                created_at: comment.created_at
            };
        });
    }

    function optionalBoolean(task, field, fallback) {
        if (!Object.prototype.hasOwnProperty.call(task, field)) {
            return fallback;
        }
        if (typeof task[field] !== 'boolean') {
            throw createError('The task server returned invalid task ' + field + ' data.');
        }
        return task[field];
    }

    function taskFromResponse(data) {
        if (!Object.prototype.hasOwnProperty.call(data, 'task')) {
            throw createError('The task server response did not include a task.');
        }
        return normalizeTask(data.task);
    }

    function editableTaskData(taskData) {
        if (!taskData || typeof taskData !== 'object' || Array.isArray(taskData)) {
            throw createError('Task data must be an object.');
        }

        var cleanTask = {};
        editableFields.forEach(function (field) {
            if (Object.prototype.hasOwnProperty.call(taskData, field)) {
                cleanTask[field] = taskData[field];
            }
        });

        return cleanTask;
    }

    function validateTaskId(taskId) {
        if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(taskId)) {
            return $.Deferred().reject(createError('A valid task ID is required.')).promise();
        }
        return null;
    }

    function mutateTask(action, taskId) {
        var invalidId = validateTaskId(taskId);
        if (invalidId) {
            return invalidId;
        }

        return request('POST', '', {
            action: action,
            id: taskId
        }).then(taskFromResponse);
    }

    function listTasksFor(action) {
        return request('GET', action).then(function (data) {
            if (!Array.isArray(data.tasks)) {
                throw createError('The task server response did not include a task list.');
            }

            return data.tasks.map(normalizeTask);
        });
    }

    function bulkSoftDeleteTasks(taskIds) {
        if (
            !Array.isArray(taskIds)
            || taskIds.length < 1
            || taskIds.length > 100
            || taskIds.some(function (taskId) {
                return typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(taskId);
            })
        ) {
            return $.Deferred().reject(createError('Select between 1 and 100 valid tasks for deletion.')).promise();
        }

        return request('POST', '', {
            action: 'bulk_soft_delete',
            taskIds: taskIds.slice()
        }).then(function (data) {
            if (
                !Number.isInteger(data.deleted_count)
                || data.deleted_count < 0
                || !Array.isArray(data.deleted_tasks)
                || !Array.isArray(data.rejected_ids)
                || data.deleted_count !== data.deleted_tasks.length
                || data.rejected_ids.some(function (id) {
                    return typeof id !== 'string';
                })
            ) {
                throw createError('The task server returned an invalid bulk-delete response.');
            }
            return {
                deleted_count: data.deleted_count,
                deleted_tasks: data.deleted_tasks.map(normalizeTask),
                rejected_ids: data.rejected_ids.slice()
            };
        });
    }

    function addTaskComment(taskId, message) {
        var invalidId = validateTaskId(taskId);
        if (invalidId) {
            return invalidId;
        }
        if (typeof message !== 'string' || !message.trim()) {
            return $.Deferred().reject(createError('Enter a comment before submitting.')).promise();
        }
        if (Array.from(message.trim()).length > 5000) {
            return $.Deferred().reject(createError('Comments must be 5000 characters or fewer.')).promise();
        }

        return request('POST', '', {
            action: 'add_comment',
            id: taskId,
            message: message.trim()
        }).then(taskFromResponse);
    }

    function clearTrashTasks() {
        return request('POST', '', {
            action: 'clear_trash'
        }).then(function (data) {
            if (
                !Number.isInteger(data.removed_count)
                || data.removed_count < 0
                || !Array.isArray(data.removed_ids)
                || data.removed_count !== data.removed_ids.length
                || data.removed_ids.some(function (id) {
                    return typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id);
                })
            ) {
                throw createError('The task server returned an invalid Clear Trash response.');
            }
            return {
                removed_count: data.removed_count,
                removed_ids: data.removed_ids.slice()
            };
        });
    }

    function normalizeTextFormatDefaults(defaults) {
        if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
            throw createError('The task server returned invalid global formatting preferences.');
        }
        return normalizeTextFormat(defaults);
    }

    function getTextFormatDefaults() {
        return request('GET', 'settings').then(function (data) {
            return normalizeTextFormatDefaults(data.text_format_defaults);
        });
    }

    function saveTextFormatDefaults(defaults) {
        var cleanDefaults;
        try {
            cleanDefaults = normalizeTextFormatDefaults(defaults);
        } catch (error) {
            return $.Deferred().reject(error).promise();
        }

        var saveRequest = textFormatDefaultsSaveQueue.then(function () {
            return request('POST', '', {
                action: 'save_text_format_defaults',
                defaults: cleanDefaults
            }).then(function (data) {
                return normalizeTextFormatDefaults(data.text_format_defaults);
            });
        });
        textFormatDefaultsSaveQueue = saveRequest.then(function () {
            return undefined;
        }, function () {
            return undefined;
        });
        return saveRequest;
    }

    var TaskStorage = {
        listTasks: function () {
            return listTasksFor('list');
        },

        listTrashTasks: function () {
            return listTasksFor('trash');
        },

        createTask: function (taskData) {
            var task;
            try {
                task = editableTaskData(taskData);
            } catch (error) {
                return $.Deferred().reject(error).promise();
            }

            return request('POST', '', {
                action: 'create',
                task: task
            }).then(taskFromResponse);
        },

        updateTask: function (taskId, taskData) {
            var invalidId = validateTaskId(taskId);
            if (invalidId) {
                return invalidId;
            }

            var task;
            try {
                task = editableTaskData(taskData);
            } catch (error) {
                return $.Deferred().reject(error).promise();
            }

            return request('POST', '', {
                action: 'update',
                id: taskId,
                task: task
            }).then(taskFromResponse);
        },

        softDeleteTask: function (taskId) {
            return mutateTask('soft_delete', taskId);
        },

        bulkSoftDeleteTasks: bulkSoftDeleteTasks,
        addTaskComment: addTaskComment,
        clearTrashTasks: clearTrashTasks,
        getTextFormatDefaults: getTextFormatDefaults,
        saveTextFormatDefaults: saveTextFormatDefaults,
        defaultTextFormat: defaultTextFormat,
        normalizeTextFormat: normalizeTextFormat,
        formatText: formatText,

        restoreTask: function (taskId) {
            return mutateTask('restore', taskId);
        },

        permanentlyDeleteTask: function (taskId) {
            return mutateTask('permanent_delete', taskId);
        }
    };

    window.TaskStorage = Object.freeze(TaskStorage);
}(window.jQuery, window));