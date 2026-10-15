(function () {
  const p = fetch('components/templates/svg-saved-assets.html?v=1').then(r => r.text());
  window._componentPromises = window._componentPromises || [];
  window._componentPromises.push(p);

  class SvgSavedAssets extends HTMLElement {
    connectedCallback() { p.then(html => { this.innerHTML = html; }); }
  }
  customElements.define('svg-saved-assets', SvgSavedAssets);
})();
