(function () {
  const p = fetch('components/templates/svg-asset-store.html?v=1').then(r => r.text());
  window._componentPromises = window._componentPromises || [];
  window._componentPromises.push(p);

  class SvgAssetStore extends HTMLElement {
    connectedCallback() { p.then(html => { this.innerHTML = html; }); }
  }
  customElements.define('svg-asset-store', SvgAssetStore);
})();
