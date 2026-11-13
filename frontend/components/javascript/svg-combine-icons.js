(function () {
  const p = fetch('components/templates/svg-combine-icons.html?v=1').then(r => r.text());
  window._componentPromises = window._componentPromises || [];
  window._componentPromises.push(p);

  class SvgCombineIcons extends HTMLElement {
    connectedCallback() { p.then(html => { this.innerHTML = html; }); }
  }
  customElements.define('svg-combine-icons', SvgCombineIcons);
})();
