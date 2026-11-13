(function () {
  const p = fetch('components/templates/svg-animate-icon.html?v=2').then(r => r.text());
  window._componentPromises = window._componentPromises || [];
  window._componentPromises.push(p);

  class SvgAnimateIcon extends HTMLElement {
    connectedCallback() { p.then(html => { this.innerHTML = html; }); }
  }
  customElements.define('svg-animate-icon', SvgAnimateIcon);
})();
