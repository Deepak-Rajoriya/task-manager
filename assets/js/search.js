(function ($, window, document) {
    'use strict';

    if (!$) {
        throw new Error('TaskSearch requires jQuery to be loaded first.');
    }

    var taskCollection = [];
    var query = '';
    var selectedPriority = 'all';
    var filteredTaskCollection = [];
    var initialized = false;
    var searchInputs = '#task-search, #task-search-mobile, #history-search';
    var priorityInputs = '#priority-filter, #history-priority-filter';
    var statuses = ['todo', 'in_progress', 'review', 'done'];
    var labels = {
        todo: 'To Do',
        in_progress: 'In Progress',
        review: 'Review',
        done: 'Done'
    };

    function text(value) {
        return typeof value === 'string' ? value : '';
    }

    function normalizedQuery(value) {
        return text(value).trim().toLocaleLowerCase();
    }

    function searchableText(task) {
        var parts = [
            task.title,
            task.description,
            task.assignee,
            task.priority
        ];

        if (Array.isArray(task.tags)) {
            parts = parts.concat(task.tags);
        }

        return parts.map(text).join(' ').toLocaleLowerCase();
    }

    function filter(tasks, searchQuery, priority) {
        if (!Array.isArray(tasks)) {
            return [];
        }

        var needle = normalizedQuery(searchQuery);
        var priorityFilter = ['all', 'high', 'medium', 'low'].indexOf(priority) !== -1
            ? priority
            : selectedPriority;
        return tasks.filter(function (task) {
            if (!task || typeof task !== 'object' || task.deleted === true) {
                return false;
            }
            return (priorityFilter === 'all' || task.priority === priorityFilter)
                && (!needle || searchableText(task).indexOf(needle) !== -1);
        });
    }

    function currentTasks() {
        if (window.TaskApp && typeof window.TaskApp.getTasks === 'function') {
            var appTasks = window.TaskApp.getTasks();
            if (Array.isArray(appTasks)) {
                taskCollection = appTasks.slice();
            }
        }
        return taskCollection;
    }

    function countByStatus(tasks) {
        var counts = {
            todo: 0,
            in_progress: 0,
            review: 0,
            done: 0
        };
        tasks.forEach(function (task) {
            if (Object.prototype.hasOwnProperty.call(counts, task.status)) {
                counts[task.status] += 1;
            }
        });
        return counts;
    }

    function createEmptyState(status) {
        var $empty = $('<div>', {
            class: 'column-empty rounded-xl border border-dashed border-slate-300/90 bg-white/60 px-3 py-8 text-center',
            'data-search-generated': 'true'
        });
        var $iconWrap = $('<span>', {
            class: status === 'done'
                ? 'mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600'
                : 'mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400'
        });
        $iconWrap.append($('<i>', {
            'data-lucide': status === 'done' ? 'check' : 'file-text',
            class: 'h-5 w-5'
        }));
        $empty.append($iconWrap);

        if (status === 'done') {
            $empty.append($('<p>', { class: 'text-sm font-semibold text-slate-700' }).text('Great work!'));
            $empty.append($('<p>', {
                class: 'mx-auto mt-1 max-w-[190px] text-xs leading-5 text-slate-500'
            }).text('All tasks in this column are completed.'));
        } else {
            $empty.append($('<p>', { class: 'text-sm font-semibold text-slate-700' }).text('No more tasks'));
            $empty.append($('<p>', {
                class: 'mx-auto mt-1 max-w-[190px] text-xs leading-5 text-slate-500'
            }).text('Add a new task to keep things moving.'));
            var $add = $('<button>', {
                type: 'button',
                class: 'quick-add mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50',
                'data-status': status
            });
            $add.append($('<i>', { 'data-lucide': 'plus', class: 'h-3.5 w-3.5' }));
            $add.append(document.createTextNode(' Add task'));
            $empty.append($add);
        }
        return $empty;
    }

    function refreshIcons() {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
        }
    }

    function renderFilteredState(filteredTasks) {
        var matchingIds = Object.create(null);
        filteredTasks.forEach(function (task) {
            matchingIds[String(task.id)] = true;
        });

        $('.task-card[data-task-id]').each(function () {
            var id = String($(this).attr('data-task-id') || '');
            $(this).toggle(Boolean(matchingIds[id]));
        });

        var statusCounts = countByStatus(filteredTasks);
        statuses.forEach(function (status) {
            var $list = $('.task-list[data-status="' + status + '"]').first();
            if (!$list.length) {
                return;
            }

            var $cards = $list.children('.task-card');
            var count = statusCounts[status];
            $list.children('[data-search-generated="true"]').remove();
            $list.children('.column-empty').toggle(count === 0);
            if (count === 0 && !$list.children('.column-empty').length) {
                $list.append(createEmptyState(status));
            }

            $list.closest('.kanban-column').find('.task-count').first().text(count);
            $cards.attr('aria-hidden', function () {
                return $(this).is(':visible') ? 'false' : 'true';
            });
        });

        var hasFilter = normalizedQuery(query) !== '' || selectedPriority !== 'all';
        $('#search-empty-state').toggle(hasFilter && filteredTasks.length === 0);
        $('#search-empty-state').attr('aria-live', 'polite');
        $('#visible-task-count').text(filteredTasks.length);
        $('#filtered-task-summary').toggleClass('hidden', !hasFilter);
        $('#search-empty-state h2').text(selectedPriority === 'all' ? 'No results found' : 'No tasks match these filters');

        var clearVisible = text(query).length > 0;
        $('#clear-search').toggleClass('hidden', !clearVisible);
        $('#clear-search-mobile').toggleClass('hidden', !clearVisible);

        refreshIcons();
    }

    function applySearch() {
        filteredTaskCollection = filter(currentTasks(), query, selectedPriority);
        renderFilteredState(filteredTaskCollection);

        $(document).trigger('taskmanager:search', [{
            query: query,
            priority: selectedPriority,
            tasks: filteredTaskCollection.slice()
        }]);
        return filteredTaskCollection;
    }

    function synchronizeInputs(value, source) {
        $(searchInputs).not(source || []).val(value);
    }

    function ensureMobileClearButton() {
        var $mobileInput = $('#task-search-mobile');
        if (!$mobileInput.length || $('#clear-search-mobile').length) {
            return;
        }

        var $button = $('<button>', {
            id: 'clear-search-mobile',
            type: 'button',
            'aria-label': 'Clear search',
            class: 'absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-lg p-1.5 text-slate-500 hover:bg-slate-200'
        });
        $button.append($('<i>', { 'data-lucide': 'x', class: 'h-4 w-4' }));

        var $wrapper = $mobileInput.parent();
        $wrapper.addClass('relative');
        $mobileInput.addClass('pr-10');
        $wrapper.append($button);
    }

    function syncClearButtons() {
        var hasQuery = text(query).length > 0;
        $('#clear-search, #clear-search-mobile, #clear-history-search').toggleClass('hidden', !hasQuery);
    }

    function clear() {
        query = '';
        $(searchInputs).val('');
        syncClearButtons();
        return applySearch();
    }

    function setPriority(priority) {
        if (['all', 'high', 'medium', 'low'].indexOf(priority) === -1) {
            throw new TypeError('Priority filter must be all, high, medium, or low.');
        }
        selectedPriority = priority;
        $('#priority-filter').val(priority);
        $(priorityInputs).val(priority);
        if (window.TaskDropdowns) {
            window.TaskDropdowns.refresh(priorityInputs);
        }
        $('.priority-filter-indicator')
            .attr('data-priority', priority)
            .toggleClass('priority-filter-high', priority === 'high')
            .toggleClass('priority-filter-medium', priority === 'medium')
            .toggleClass('priority-filter-low', priority === 'low');
        return applySearch();
    }

    function isEditableTarget(target) {
        if (!target) {
            return false;
        }
        if (target.isContentEditable) {
            return true;
        }
        return $(target).closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]').length > 0;
    }

    function focusSearch() {
        var $desktop = $('#task-search');
        var $mobile = $('#task-search-mobile');
        var $target = $desktop.is(':visible') ? $desktop : $mobile;
        if ($target.length) {
            $target.trigger('focus');
            if (typeof $target[0].select === 'function') {
                $target[0].select();
            }
        }
    }

    function setTasks(tasks) {
        if (!Array.isArray(tasks)) {
            throw new TypeError('TaskSearch.setTasks expects an array.');
        }
        taskCollection = tasks.slice();
        return applySearch();
    }

    function updateTaskFromEvent(detail) {
        if (!detail || !detail.task || typeof detail.task.id !== 'string') {
            return;
        }

        var index = taskCollection.findIndex(function (task) {
            return task && task.id === detail.task.id;
        });
        if (index === -1) {
            taskCollection.push(detail.task);
        } else {
            taskCollection[index] = detail.task;
        }
        applySearch();
    }

    function init() {
        if (initialized) {
            return TaskSearch;
        }
        initialized = true;
        ensureMobileClearButton();

        $(document)
            .off('.taskSearch')
            .on('input.taskSearch', searchInputs, function () {
                query = $(this).val() || '';
                synchronizeInputs(query, this);
                syncClearButtons();
                applySearch();
            })
            .on('change.taskSearch', priorityInputs, function () {
                setPriority($(this).val());
            })
            .on('click.taskSearch', '#clear-search, #clear-search-mobile, #clear-history-search', function () {
                clear();
                focusSearch();
            })
            .on('keydown.taskSearch', searchInputs, function (event) {
                if (event.key === 'Escape' && ($(this).val() || '').length) {
                    event.preventDefault();
                    clear();
                    $(this).trigger('focus');
                }
            })
            .on('keydown.taskSearch', function (event) {
                if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event.target)) {
                    event.preventDefault();
                    focusSearch();
                }
            })
            .on('taskmanager:tasks-loaded.taskSearch', function (event, tasks) {
                if (Array.isArray(tasks)) {
                    taskCollection = tasks.slice();
                    applySearch();
                }
            })
            .on('taskmanager:board-rendered.taskSearch', function (event, tasks) {
                if (Array.isArray(tasks)) {
                    taskCollection = tasks.slice();
                }
                applySearch();
            })
            .on('taskmanager:changed.taskSearch', function (event, detail) {
                updateTaskFromEvent(detail);
            });

        if (window.TaskApp && typeof window.TaskApp.getTasks === 'function') {
            var appTasks = window.TaskApp.getTasks();
            if (Array.isArray(appTasks)) {
                taskCollection = appTasks.slice();
            }
        } else if (Array.isArray(window.initialTasks)) {
            taskCollection = window.initialTasks.slice();
        }

        query = $('#task-search').val() || $('#task-search-mobile').val() || $('#history-search').val() || '';
        selectedPriority = $('#priority-filter').val() || $('#history-priority-filter').val() || 'all';
        synchronizeInputs(query);
        syncClearButtons();
        setPriority(selectedPriority);
        return TaskSearch;
    }

    var TaskSearch = {
        init: init,
        filter: filter,
        clear: clear,
        setPriority: setPriority,
        getQuery: function () {
            return query;
        },
        getPriority: function () {
            return selectedPriority;
        },
        getFilteredTasks: function () {
            return filteredTaskCollection.slice();
        },
        setTasks: setTasks
    };

    window.TaskSearch = Object.freeze(TaskSearch);
    $(init);
}(window.jQuery, window, document));