export function deleteButton(transaction, api, reload, message) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'secondary delete-transaction';
  button.textContent = 'Delete';
  button.setAttribute('aria-label', `Delete ${transaction.merchant} on ${transaction.date}`);
  button.onclick = async () => {
    const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(transaction.amount / 100);
    if (!window.confirm(`Delete ${transaction.merchant} (${amount}) on ${transaction.date}?${transaction.split ? '\nIts split will also be removed.' : ''}\nThis cannot be undone.`)) return;
    button.disabled = true;
    try {
      await api('/api/transactions/' + encodeURIComponent(transaction.id), 'DELETE');
    } catch (error) { message.textContent = error.message; button.disabled = false; return; }
    message.textContent = 'Transaction deleted.';
    try { await reload(); }
    catch { button.remove(); message.textContent = 'Transaction deleted. Refresh the page to update your totals.'; }
  };
  return button;
}
