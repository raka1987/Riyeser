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
})();
