const catalog = require('./catalog');
const { getActivity, listSellers } = require('./admin-auth');
const { sellerStats } = require('./seller-dashboard');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}

function renderAdminDashboard() {
  const sellers = listSellers();
  const totalProducts = catalog.getProducts().length;
  const sellerRows = sellers.length
    ? sellers
        .map((seller) => {
          const stats = sellerStats(seller.username);
          return `<tr>
            <td><strong>${esc(seller.username)}</strong>${seller.revoked ? '<br><span class="err-inline">Revoked</span>' : ''}</td>
            <td>${money(stats.totalEarnings)}</td>
            <td>${esc(stats.unitsSold)}</td>
            <td>${esc(stats.products.length)}</td>
            <td>${
              seller.revoked
                ? '<span class="muted">Access revoked</span>'
                : `<form method="post" action="/admin/catalog" class="inline-form">
                    <input type="hidden" name="action" value="revoke_seller" />
                    <input type="hidden" name="username" value="${esc(seller.username)}" />
                    <button type="submit" class="danger small-btn">Revoke Access</button>
                  </form>`
            }</td>
          </tr>`;
        })
        .join('\n')
    : '<tr><td colspan="5" class="muted">No sellers configured yet.</td></tr>';

  const activityRows = getActivity(30)
    .map(
      (item) =>
        `<tr><td>${esc(new Date(item.at).toLocaleString())}</td><td>${esc(item.actor)}</td><td>${esc(
          item.action
        )}</td><td>${esc(item.detail)}</td></tr>`
    )
    .join('\n');

  return `<section class="card tab-panel active" id="tab-dashboard">
    <h2>Admin Dashboard</h2>
    <div class="metrics">
      <div class="metric"><strong>${esc(sellers.length)}</strong><span>Sellers</span></div>
      <div class="metric"><strong>${esc(totalProducts)}</strong><span>Products</span></div>
      <div class="metric"><strong>${money(sellers.reduce((sum, seller) => sum + sellerStats(seller.username).totalEarnings, 0))}</strong><span>Seller earnings</span></div>
    </div>

    <h2 style="margin-top:1rem">Create Seller Account</h2>
    <form method="post" action="/admin/catalog" class="seller-form">
      <input type="hidden" name="action" value="create_seller" />
      <label>Seller Username</label>
      <input name="username" required minlength="3" maxlength="80" placeholder="seller1" />
      <label>Seller Password</label>
      <input name="password" type="password" required minlength="6" placeholder="At least 6 characters" />
      <button type="submit">Create Seller</button>
    </form>

    <h2 style="margin-top:1rem">Sellers</h2>
    <table>
      <thead><tr><th>Seller</th><th>All-time earnings</th><th>Files sold</th><th>Uploads</th><th>Access</th></tr></thead>
      <tbody>${sellerRows}</tbody>
    </table>

    <h2 style="margin-top:1rem">Activity</h2>
    <table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What changed</th></tr></thead>
      <tbody>${activityRows || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody>
    </table>
  </section>`;
}

module.exports = { renderAdminDashboard };
