(function ($, window, document) {
    'use strict';

    if (!$) {
        throw new Error('TaskDropdowns requires jQuery to be loaded first.');
    }

    var instances = [];
    var instanceCounter = 0;
    var typeaheadText = '';
    var typeaheadTimer = null;
    var statusColors = {
        todo: 'slate',
        in_progress: 'blue',
        review: 'amber',
        done: 'emerald'
    };
    var priorityColors = {
        high: 'red',
        medium: 'amber',
        low: 'emerald'
    };

    function lucideIcon(name, className) {
        var icon = document.createElement('i');
        icon.setAttribute('data-lucide', name);
        icon.className = className;
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function decorateOption(select, option, target) {
        var value = option.value;
        var dot = null;

        if (select.id === 'task-status') {
            dot = document.createElement('span');
            dot.className = 'dropdown-status-dot status-' + (statusColors[value] || 'slate');
        } else if (select.id === 'task-priority' || select.id.indexOf('priority-filter') !== -1) {
            if (value !== 'all') {
                dot = document.createElement('span');
                dot.className = 'dropdown-priority-dot priority-' + (priorityColors[value] || 'slate');
            }
        } else if (select.id === 'task-assignee') {
            target.appendChild(lucideIcon('user-round', 'h-4 w-4 shrink-0 text-slate-400'));
        } else if (select.id === 'task-reminder-minutes') {
            target.appendChild(lucideIcon('bell-ring', 'h-4 w-4 shrink-0 text-slate-400'));
        }

        if (dot) {
            target.appendChild(dot);
        }
        var label = document.createElement('span');
        label.className = 'custom-dropdown-label';
        label.textContent = option.textContent;
        target.appendChild(label);
    }

    function enabledOptions(select) {
        return Array.prototype.slice.call(select.options).filter(function (option) {
            return !option.disabled;
        });
    }

    function initializeSelect(select) {
        if (select.dataset.customDropdownInitialized === 'true') {
            return;
        }
        select.dataset.customDropdownInitialized = 'true';
        instanceCounter += 1;

        var parent = select.parentElement;
        if (!parent) {
            return;
        }
        var nativeWidth = select.getBoundingClientRect().width;
        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-dropdown-trigger';
        trigger.setAttribute('role', 'combobox');
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', 'custom-dropdown-list-' + instanceCounter);
        var labels = select.labels ? Array.prototype.map.call(select.labels, function (label) {
            return label.textContent.trim();
        }).filter(Boolean) : [];
        trigger.setAttribute('aria-label', select.getAttribute('aria-label') || labels.join(' ') || select.name || 'Choose an option');
        if (select.getAttribute('aria-describedby')) {
            trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
        }
        trigger.id = 'custom-dropdown-trigger-' + instanceCounter;

        if (parent.classList.contains('relative') && parent.classList.contains('block')) {
            trigger.classList.add('custom-dropdown-trigger-wide');
        } else {
            trigger.style.width = Math.max(nativeWidth, 1) + 'px';
        }

        var menu = document.createElement('div');
        menu.id = 'custom-dropdown-list-' + instanceCounter;
        menu.className = 'custom-dropdown-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-labelledby', trigger.id);
        menu.hidden = true;
        menu.dataset.customDropdownMenu = 'true';

        var instance = {
            select: select,
            parent: parent,
            trigger: trigger,
            menu: menu,
            options: [],
            activeIndex: -1,
            open: false,
            update: null,
            close: null,
            position: null
        };

        function renderTrigger() {
            trigger.replaceChildren();
            var options = enabledOptions(select);
            var selectedOption = options.find(function (option) {
                return option.value === select.value;
            }) || options[0];
            var valueWrap = document.createElement('span');
            valueWrap.className = 'custom-dropdown-value';
            if (selectedOption) {
                decorateOption(select, selectedOption, valueWrap);
            } else {
                valueWrap.textContent = 'Choose an option';
            }
            var chevron = lucideIcon('chevron-down', 'h-4 w-4 shrink-0 text-slate-400 transition-transform');
            trigger.append(valueWrap, chevron);
            trigger.disabled = select.disabled;
            trigger.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
            trigger.title = selectedOption ? selectedOption.textContent : '';
            if (window.lucide && typeof window.lucide.createIcons === 'function') {
                window.lucide.createIcons({ root: trigger });
            }
        }

        function renderOptions() {
            menu.replaceChildren();
            instance.options = enabledOptions(select);
            instance.options.forEach(function (option, index) {
                var item = document.createElement('div');
                item.className = 'custom-dropdown-option';
                item.id = menu.id + '-option-' + index;
                item.setAttribute('role', 'option');
                item.tabIndex = -1;
                item.setAttribute('aria-selected', option.value === select.value ? 'true' : 'false');
                item.dataset.optionIndex = String(index);
                decorateOption(select, option, item);
                if (option.value === select.value) {
                    item.classList.add('is-selected');
                }
                menu.appendChild(item);
            });
            if (window.lucide && typeof window.lucide.createIcons === 'function') {
                window.lucide.createIcons({ root: menu });
            }
        }

        function positionMenu() {
            var rect = trigger.getBoundingClientRect();
            var maxMenuHeight = Math.min(280, window.innerHeight - 24);
            menu.style.maxHeight = maxMenuHeight + 'px';
            menu.style.width = Math.min(rect.width, window.innerWidth - 24) + 'px';
            menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12)) + 'px';
            var actualHeight = Math.min(menu.scrollHeight, maxMenuHeight);
            var below = window.innerHeight - rect.bottom - 8;
            var above = rect.top - 8;
            var openUp = below < Math.min(actualHeight, 180) && above > below;
            if (openUp) {
                menu.style.top = Math.max(8, rect.top - actualHeight - 6) + 'px';
                menu.style.bottom = 'auto';
            } else {
                menu.style.top = Math.min(rect.bottom + 6, window.innerHeight - actualHeight - 8) + 'px';
                menu.style.bottom = 'auto';
            }
        }

        function setActive(index) {
            if (!instance.options.length) {
                instance.activeIndex = -1;
                trigger.removeAttribute('aria-activedescendant');
                return;
            }
            instance.activeIndex = Math.max(0, Math.min(index, instance.options.length - 1));
            trigger.setAttribute('aria-activedescendant', menu.id + '-option-' + instance.activeIndex);
            Array.prototype.forEach.call(menu.children, function (item, itemIndex) {
                item.classList.toggle('is-active', itemIndex === instance.activeIndex);
            });
            var active = menu.children[instance.activeIndex];
            if (active) {
                active.scrollIntoView({ block: 'nearest' });
            }
        }

        function selectIndex(index) {
            var option = instance.options[index];
            if (!option) {
                return;
            }
            if (option.value === select.value) {
                closeMenu(true);
                return;
            }
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            renderTrigger();
            renderOptions();
            closeMenu(true);
        }

        function closeMenu(restoreFocus) {
            if (!instance.open) {
                return;
            }
            instance.open = false;
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            trigger.classList.remove('is-open');
            trigger.removeAttribute('aria-activedescendant');
            if (restoreFocus) {
                trigger.focus();
            }
        }

        function openMenu(preferLast) {
            if (trigger.disabled || instance.open) {
                return;
            }
            instances.forEach(function (other) {
                if (other !== instance) {
                    other.close(false);
                }
            });
            renderOptions();
            document.body.appendChild(menu);
            menu.hidden = false;
            instance.open = true;
            trigger.setAttribute('aria-expanded', 'true');
            trigger.classList.add('is-open');
            positionMenu();
            var selectedIndex = instance.options.findIndex(function (option) {
                return option.value === select.value;
            });
            setActive(preferLast
                ? (selectedIndex === -1 ? instance.options.length - 1 : selectedIndex - 1)
                : (selectedIndex === -1 ? 0 : selectedIndex));
        }

        instance.update = function () {
            renderTrigger();
            if (instance.open) {
                renderOptions();
                positionMenu();
            }
        };
        instance.close = closeMenu;
        instance.position = positionMenu;
        instances.push(instance);

        select.classList.add('custom-dropdown-source');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        var oldChevron = parent.querySelector(':scope > [data-lucide="chevron-down"]');
        if (oldChevron) {
            oldChevron.classList.add('custom-dropdown-native-chevron');
        }
        select.insertAdjacentElement('afterend', trigger);
        var label = select.closest('label');
        if (label) {
            label.addEventListener('click', function (event) {
                if (event.target === trigger || trigger.contains(event.target)) {
                    return;
                }
                event.preventDefault();
                trigger.focus();
            });
        }
        renderTrigger();
        renderOptions();

        trigger.addEventListener('click', function (event) {
            event.stopPropagation();
            if (instance.open) {
                closeMenu(false);
            } else {
                openMenu(false);
            }
        });
        trigger.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (!instance.open) {
                    openMenu(false);
                } else {
                    setActive(instance.activeIndex + 1);
                }
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                if (!instance.open) {
                    openMenu(true);
                } else {
                    setActive(instance.activeIndex - 1);
                }
            } else if (event.key === 'Home' && instance.open) {
                event.preventDefault();
                setActive(0);
            } else if (event.key === 'End' && instance.open) {
                event.preventDefault();
                setActive(instance.options.length - 1);
            } else if ((event.key === 'Enter' || event.key === ' ') && instance.open) {
                event.preventDefault();
                selectIndex(instance.activeIndex);
            } else if (event.key === 'Escape' && instance.open) {
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
            } else if (event.key === 'Tab' && instance.open) {
                closeMenu(false);
            } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                typeaheadText += event.key.toLocaleLowerCase();
                window.clearTimeout(typeaheadTimer);
                typeaheadTimer = window.setTimeout(function () {
                    typeaheadText = '';
                }, 700);
                var start = instance.open ? instance.activeIndex + 1 : 0;
                var match = instance.options.findIndex(function (option, index) {
                    return index >= start && option.textContent.trim().toLocaleLowerCase().indexOf(typeaheadText) === 0;
                });
                if (match === -1) {
                    match = instance.options.findIndex(function (option) {
                        return option.textContent.trim().toLocaleLowerCase().indexOf(typeaheadText) === 0;
                    });
                }
                if (match !== -1) {
                    if (!instance.open) {
                        openMenu(false);
                    }
                    setActive(match);
                }
            }
        });
        menu.addEventListener('click', function (event) {
            var item = event.target.closest('[role="option"]');
            if (item) {
                selectIndex(Number(item.dataset.optionIndex));
            }
        });
        menu.addEventListener('pointerdown', function (event) {
            var item = event.target.closest('[role="option"]');
            event.stopPropagation();
            if (item) {
                event.preventDefault();
                selectIndex(Number(item.dataset.optionIndex));
            }
        });
        select.addEventListener('change', instance.update);

        if (window.MutationObserver) {
            var observer = new MutationObserver(instance.update);
            observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        }
    }

    function closeOutside(event) {
        instances.forEach(function (instance) {
            if (
                instance.open
                && !instance.parent.contains(event.target)
                && !instance.menu.contains(event.target)
            ) {
                instance.close(false);
            }
        });
    }

    function initialize() {
        document.querySelectorAll('select').forEach(initializeSelect);
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('focusin', closeOutside);
        window.addEventListener('resize', function () {
            instances.forEach(function (instance) {
                if (instance.open) {
                    instance.position();
                }
            });
        });
        window.addEventListener('scroll', function () {
            instances.forEach(function (instance) {
                if (instance.open) {
                    instance.position();
                }
            });
        }, true);
    }

    function refresh(selector) {
        instances.forEach(function (instance) {
            if (!selector || instance.select.matches(selector)) {
                instance.update();
            }
        });
    }

    window.TaskDropdowns = Object.freeze({
        refresh: refresh
    });

    $(initialize);
}(window.jQuery, window, document));
