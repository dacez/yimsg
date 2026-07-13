(function () {
  'use strict';

  var STORAGE_KEY = 'yimsg-lang';
  var DEFAULT_LANG = 'en';

  function getLang() {
    return document.documentElement.classList.contains('lang-zh') ? 'zh' : 'en';
  }

  function setLang(lang) {
    var html = document.documentElement;
    if (lang === 'zh') {
      html.classList.add('lang-zh');
      html.lang = 'zh-CN';
      document.title = 'yimsg · 极简单机部署的私有化即时通讯';
      var metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.content = 'yimsg 是一套极简单机部署、数据完全自主的私有化即时通讯框架。一台机器、几分钟即可部署上线，所有数据不经任何第三方云，完全由你掌控。';
    } else {
      html.classList.remove('lang-zh');
      html.lang = 'en';
      document.title = 'yimsg · Self-hosted Instant Messaging';
      var metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.content = 'yimsg is a minimalist self-hosted instant messaging system: deploy on a single machine in minutes, all data stays on your own hardware. Embed chat into your website with one line of code, or run as a standalone web app.';
    }
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  }

  // Toggle button handler
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('langToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        setLang(getLang() === 'en' ? 'zh' : 'en');
      });
    }
  });

  // Expose for programmatic use
  window.yimsgSetLang = setLang;
  window.yimsgGetLang = getLang;
})();
