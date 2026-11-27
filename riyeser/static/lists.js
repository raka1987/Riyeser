// List screens (templates/_list.html): a drop-down applies straight away; Year and Period take turns;
// "Custom dates" shows From and To and waits for Apply.
(function () {
  document.querySelectorAll("form[data-lbar]").forEach(function (f) {
    var year = f.querySelector("[data-year]"), period = f.querySelector("[data-period]");
    function custom() {
      var on = period && period.value === "custom";
      f.querySelectorAll("[data-custom]").forEach(function (d) { d.hidden = !on; });
      return on;
    }
    f.addEventListener("change", function (e) {
      var t = e.target;
      if (!t.matches("select[data-auto]")) return;
      if (t === year && year.value && period && period.value !== "custom") period.value = "";
      if (t === period && period.value && year) year.value = "";
      if (t === period && custom()) { var d = f.querySelector("[data-custom] input"); if (d) d.focus(); return; }
      var pg = f.querySelector("input[name$='page']"); if (pg) pg.remove();
      f.submit();
    });
  });
  // When the bar needs two rows, search and the count share the first row (instead of the count sitting alone on
  // a row of its own) and the drop-downs and Apply make the second.
  function lay() {
    document.querySelectorAll("form.lbar").forEach(function (f) {
      f.classList.remove("two");
      var end = f.querySelector(".lend"), q = f.querySelector(".lf-q");
      if (!end || !q || !end.offsetParent) return;
      if (end.getBoundingClientRect().bottom > q.getBoundingClientRect().bottom + 4) f.classList.add("two");   // on a row below search
    });
  }
  lay();
  var t; window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(lay, 100); });
})();
