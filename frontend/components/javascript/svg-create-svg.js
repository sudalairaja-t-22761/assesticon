(function () {
  const p = fetch('components/templates/svg-create-svg.html?v=4').then(r => r.text());
  window._componentPromises = window._componentPromises || [];
  window._componentPromises.push(p);
  class SvgCreateSvg extends HTMLElement {
    connectedCallback() { p.then(html => { this.innerHTML = html; }); }
  }
  customElements.define('svg-create-svg', SvgCreateSvg);
})();
