/**
 * 吉祥物模块（Mascot）
 * --------------------------------------------------------------------
 * 设计目标
 *   1. 点击顶部标题左侧的图标，随机出现一只小动物（小猫/小狗/小鸟/小鸡/小熊猫/小羊）
 *   2. 动物以冒泡气泡形式展示一条"抚慰打工人"的话语
 *   3. 每次随机选取动物与话语，动画淡入淡出，自动消失
 *
 * 暴露对象：window.Mascot
 *   - init()   // 绑定图标点击事件
 */
(function (global) {
    'use strict';

    /** 可用小动物（emoji + 名称） */
    var ANIMALS = [
        { name: '小猫',   emoji: '🐱' },
        { name: '小狗',   emoji: '🐶' },
        { name: '小鸟',   emoji: '🐦' },
        { name: '小鸡',   emoji: '🐤' },
        { name: '小熊猫', emoji: '🐼' },
        { name: '小羊',   emoji: '🐑' }
    ];

    /** 抚慰打工人的话语 */
    var PHRASES = [
        '今天也要加油鸭！',
        '你已经很棒了，辛苦了～',
        '喝口水，歇一歇再继续。',
        '慢慢来，比较快。',
        '天大的事，睡一觉就好啦。',
        '再坚持一下，马上就能下班啦。',
        '生活不止眼前的报表，还有热茶和远方。',
        '你已经做得很好啦。',
        '乌云散去，就是晴天。',
        '照顾好自己，才是最重要的事。',
        '每一次坚持，都在靠近想要的未来。',
        '今天也要元气满满哦！',
        '累了就停下来看看云。',
        '你认真工作的样子，特别帅。',
        '别急，好事都会如约而至。',
        '世界很大，但你并不孤单。'
    ];

    var bubbleTimer = null;

    function pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /**
     * 创建并展示冒泡气泡（挂在 body 上，绝对定位在图标下方）
     */
    function showBubble() {
        var animal = pick(ANIMALS);
        var phrase = pick(PHRASES);

        // 移除旧气泡
        var old = document.getElementById('mascot-bubble');
        if (old) old.remove();

        var bubble = document.createElement('div');
        bubble.id = 'mascot-bubble';
        bubble.className = 'mascot-bubble';

        bubble.innerHTML =
            '<div class="mascot-bubble-body">' +
                '<span class="mascot-emoji" aria-hidden="true">' + animal.emoji + '</span>' +
                '<span class="mascot-text">' + phrase + '</span>' +
            '</div>' +
            '<div class="mascot-bubble-tail" aria-hidden="true"></div>';

        document.body.appendChild(bubble);

        // 定位到图标附近（复用品牌图标的位置）
        var mark = document.getElementById('brand-mark');
        if (mark) {
            var rect = mark.getBoundingClientRect();
            bubble.style.left = Math.max(8, rect.left) + 'px';
            bubble.style.top = (rect.bottom + 10) + 'px';
        } else {
            bubble.style.left = '14px';
            bubble.style.top = '78px';
        }

        // 触发入场动画
        // eslint-disable-next-line no-unused-expressions
        bubble.offsetHeight;
        bubble.classList.add('show');

        if (global.Logger) Logger.info('吉祥物：' + animal.name + ' · ' + phrase);

        // 自动消失
        clearTimeout(bubbleTimer);
        bubbleTimer = setTimeout(function () {
            bubble.classList.remove('show');
            setTimeout(function () { bubble.remove(); }, 320);
        }, 3500);

        // 点击立即关闭
        bubble.addEventListener('click', function () {
            bubble.classList.remove('show');
            setTimeout(function () { bubble.remove(); }, 320);
        });
    }

    function init() {
        var mark = document.getElementById('brand-mark');
        if (!mark) return;
        mark.addEventListener('click', showBubble);
        // 键盘可达性：Enter / Space 触发彩蛋
        // 与 role="button" + tabindex="0" 配合，满足无障碍标准
        mark.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                showBubble();
            }
        });
        if (global.Logger) Logger.info('吉祥物模块已初始化');
    }

    global.Mascot = {
        init: init
    };
})(window);
