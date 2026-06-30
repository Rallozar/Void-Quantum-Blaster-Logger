// ==UserScript==
// @name         Void Quantum Blaster Logger
// @namespace    http://tampermonkey.net/
// @version      2026.06.30
// @updateURL    https://raw.githubusercontent.com/Rallozar/Void-Quantum-Blaster-Logger/main/Void-Quantum-Blaster-Logger.user.js
// @description  A userscript that keeps track of item gotten with Void Quantum Blaster. Works with two blasters at once.
// @author       rallozarx
// @match        https://www.neopets.com/dome/*
// @icon         https://images.neopets.com/themes/h5/basic/images/battledome-icon.png
// @run-at       document-end
// @connect      itemdb.com.br
// @grant        GM_xmlhttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// ==/UserScript==

// ATTENTION!
// If recently updated, it is recommended to run updatePrices before battling.

// Summary:
// This userscript adds an item gotten with Void Quantum Blaster to a list, or increases the quantity by 1 if you already got it.
// The amount of uses of Void Quantum Blaster is also kept track, and displayed when viewing the download.
// The price is also collected from itemdb and updated each time the same item is added. There is an update button to force an update for your log
// DO NOT leave the page before the update is finished, as problems may occur.
// The list is hidden and can only be viewed by downloading the csv. Three icons, Clear, Update, and Download, are added to the bookmark bar in the dome.

// Configuration:
// Set itemdbMedianCount to a positive integer that determines how many past prices
// you get a median of. Set it to 1 to just get the most recent price.
const itemdbMedianCount = 20; //default is 20

(function() {
    'use strict';

    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const STORAGE = "voidquantumblaster";
    const TRACKED = "blastercount";

    const getItems = async () => {
        const storage = await GM.getValue(STORAGE, "[]");
        return JSON.parse(storage);
    }

    const clearAllItems = () => {
        GM.setValue(TRACKED, 0);
        GM.setValue(STORAGE, "[]");
    }

    function fetchItemPrice(itemName) {
        const itemSlug = itemName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '');
        const itemPageUrl = `https://itemdb.com.br/item/${itemSlug}`;
        console.log(itemPageUrl);

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: itemPageUrl,
                onload: function (res) {
                    if (res.status !== 200) {
                        return resolve('Error Fetching Price');
                    }

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(res.responseText, 'text/html');
                    const rows = Array.from(doc.querySelectorAll('table tbody tr'));
                    const priceCells = [];
                    let hasWarning = false;

                    for (const row of rows) {
                        const firstTd = row.querySelector('td:first-child');
                        if (!firstTd || !firstTd.textContent) continue;

                        const text = firstTd.textContent.trim().replace(/,/g, '').replace(/[^\d]/g, '');
                        const price = parseInt(text, 10);
                        if (!isNaN(price)) {
                            priceCells.push(price);
                        }

                        const rowText = row.textContent.toLowerCase();
                        const containsKeyword = /(added|unavailable|quest|daily|pool)/.test(rowText);
                        const containsLink = row.querySelector('a') !== null;

                        if (containsKeyword || containsLink) {
                            hasWarning = true;
                        }

                        if (priceCells.length >= itemdbMedianCount) break;
                    }

                    if (priceCells.length === 0) {
                        return resolve('No Price Data');
                    }
                    priceCells.sort((a, b) => a - b);
                    const mid = Math.floor(priceCells.length / 2);
                    const median = priceCells.length % 2 === 0
                    ? Math.round((priceCells[mid - 1] + priceCells[mid]) / 2)
                    : priceCells[mid];

                    resolve(median);
                },
                onerror: function () {
                    resolve('Error Fetching Price');
                }
            });
        });
    }

    async function fetchAllItemPrices(itemArray, onProgress) {
        const results = [];
        const now = Date.now();

        for (let i = 0; i < itemArray.length; i++) {
            const itemData = itemArray[i];
            console.log(`[${i + 1}/${itemArray.length}] Fetching price for: ${itemData.item}`);
            if (!itemData.lastUpdated) {
                itemData.lastUpdated = now + CACHE_DURATION;
            }
            if (now - itemData.lastUpdated < CACHE_DURATION) {
                console.log("Price was updated less than 24 hours ago. Skipping update.");
                results.push(itemData);
                continue;
            }

            try {
                const newPrice = await fetchItemPrice(itemData.item);
                results.push({ item: itemData.item, quantity: itemData.quantity, price: newPrice, lastUpdated: now});

                if (typeof onProgress === 'function') {
                    onProgress({
                        current: i + 1,
                        total: itemArray.length,
                        itemName: itemData.item,
                        price: newPrice
                    });
                }
            } catch (error) {
                console.error(`Failed to fetch ${itemData.item}:`, error);
                results.push({ item: itemData.item, quantity: itemData.quantity, price: 'Error', lastUpdated: now});
            }

            if (i < itemArray.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return results;
    }

    const updatePrices = async () => {
        try {
            const items = await getItems();
            console.log(items);

            const updatedItemList = await fetchAllItemPrices(items, (result) => {
                console.log(result.current + '/' + result.total + ': ' + result.itemName + ' - ' + result.price);
            });

            await updatedItemList.sort((a, b) => {
                const priceA = parseInt(String(a.price).replace(/[^\d]/g, ''), 10) || 0;
                const priceB = parseInt(String(b.price).replace(/[^\d]/g, ''), 10) || 0;

                return priceB - priceA;
            });

            GM.setValue(STORAGE, JSON.stringify(updatedItemList));

            return true;
        } catch (error) {
            console.error("Error updating prices:", error);
            throw error;
        }
    };

    const exportItemLogsToCsv = async () => {
        getItems().then(async (items) => {
            const filename = "neopets-void-quantum-blaster-log.csv";
            const headers = ["Item", "Quantity", "Price"];
            const csvData = [headers.join(',')];

            const trackedBattles = await GM.getValue(TRACKED, 0);
            const totalQuantity = items.reduce((sum, current) => sum + current.quantity, 0);
            const totalInventoryValueRaw = items.reduce((sum, current) => {
                const cleanPrice = parseInt(String(current.price).replace(/[^\d]/g, ''), 10) || 0;
                return sum + (cleanPrice * current.quantity);
            }, 0);
            const totalInventoryValueFormatted = totalInventoryValueRaw.toLocaleString();

            csvData.push(["Total", totalQuantity, `"${totalInventoryValueFormatted}"`]);
            csvData.push(["Total blaster uses", parseInt(String(trackedBattles).replace(/[^\d]/g, ''), 10) || 0 , ""])
            csvData.push("");

            items.forEach(item => {
                let formattedPrice = item.price;

                const numericMatch = String(item.price).match(/\d+/);
                if (numericMatch) {
                    const rawNumber = parseInt(numericMatch[0], 10);
                    const commasNumber = rawNumber.toLocaleString();

                    formattedPrice = String(item.price).replace(/\d+/, commasNumber);
                }

                csvData.push([
                    `"${item.item}"`,
                    item.quantity,
                    `"${formattedPrice}"`
                ].join(','))
            });

            const blob = new Blob([csvData.join("\n")], { type: 'text/csv;charset=utf-8;' });
            if (navigator.msSaveBlob) { // IE 10+
                navigator.msSaveBlob(blob, filename);
            } else {
                const link = document.createElement("a");
                if (link.download !== undefined) {
                    const url = URL.createObjectURL(blob);
                    link.setAttribute("href", url);
                    link.setAttribute("download", filename);
                    link.style.visibility = 'hidden';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                }
            }
        });
    };

    const titleContainer = document.querySelector('.navsub-left__2020');

    if (titleContainer) {

        const clearTag = document.createElement('a');
        clearTag.innerHTML = '<img src="https://images.neopets.com/ncmall/buttons/btn_delete.gif" alt="Clear" style="vertical-align: middle; width: 30px; height: 30px;">';
        clearTag.title = 'Clear item log';
        clearTag.style.marginRight = '10px';
        clearTag.style.cursor = 'pointer';
        clearTag.style.display = 'inline-flex';
        clearTag.style.position = 'relative';
        clearTag.style.top = '5px';
        clearTag.onclick = function() {
            if (window.confirm("Are you sure you want to clear the item log?")) {
                clearAllItems();
                alert("Item log cleared.");
            }
        };

        const updateTag = document.createElement('a');
        updateTag.innerHTML = '<img src="https://images.neopets.com/prehistoric/obelisk/refreshquest_bh3y98ur/btn_refreshquest.png" alt="Update" style="vertical-align: middle; width: 30px; height: 30px; object-fit: cover; object-position: top;">';
        updateTag.title = 'Update prices in log';
        updateTag.style.marginRight = '10px';
        updateTag.style.cursor = 'pointer';
        updateTag.style.display = 'inline-flex';
        updateTag.style.position = 'relative';
        updateTag.style.top = '5px';
        updateTag.onclick = function() {
            if (window.confirm('This could take some time. Are you sure you wish to update your log?')) {
            alert('Please wait for the success message before leaving the page.');
                updatePrices()
                    .then(() => {
                    alert('Prices successfully updated. You can now leave the page.');
                })
                    .catch((error) => {
                    console.error("Promise rejected:", error);
                });
            }
        };

        const downloadTag = document.createElement('a');
        downloadTag.innerHTML = '<img src="https://images.neopets.com/neohome2/public_html/disk.png" alt="Download" style="vertical-align: middle; width: 30px; height: 30px;">';
        downloadTag.title = 'Download item log';
        downloadTag.style.cursor = 'pointer';
        downloadTag.style.display = 'inline-flex';
        downloadTag.style.position = 'relative';
        downloadTag.style.top = '5px';
        downloadTag.onclick = function() {
            exportItemLogsToCsv()
            .then()
            .catch((error) => {
                console.error("Promise rejected:", error);
            });
        };

        titleContainer.appendChild(clearTag);
        titleContainer.appendChild(updateTag);
        titleContainer.appendChild(downloadTag);
    }

    const targetNode = document.getElementById('flround') || document.body;

    let round = 0;

    const observer = new MutationObserver((mutations) => {
        const roundText = targetNode?.innerText || '';
        const nextRound = String(round + 1);

        if (roundText.includes(nextRound)) {
            round++;

            const messageCells = document.querySelectorAll('#log td.msg');
            const customItemsArray = [];
            const blasterPattern = /You release a powerful blast of darkness from the Void Quantum Blaster at\s+(.+)/i;
            const rewardPattern = /You have also been rewarded with\s+(.+)/i;
            let tempTracked = 0;

            messageCells.forEach(cell => {
                const text = cell.textContent.trim();
                const match = text.match(rewardPattern);
                if (match) {
                    customItemsArray.push(match[1].trim());
                }
                const blasterMatch = text.match(blasterPattern);
                if (blasterMatch) {
                    tempTracked++;
                }
            });

            if (!!customItemsArray.length) {
                getItems().then(async (items) => {
                    let tracked = await GM.getValue(TRACKED, 0);
                    const now = Date.now();
                    tracked+= tempTracked;
                    console.log(items);
                    for (const item of customItemsArray) {
                        let existingItem = items.find(entry => entry.item === item);

                        if (existingItem) {
                            // Update quantity and price for existing items.
                            existingItem.quantity += 1;
                            if (now - itemData.lastUpdated >= CACHE_DURATION) {
                                existingItem.price = await fetchItemPrice(item);
                                existingItem.lastUpdated = now;
                            }
                        } else {
                            const newPrice = await fetchItemPrice(item);
                            items.push({ item: item, quantity: 1, price: newPrice, lastUpdated: now});
                        }
                    }
                    items.sort((a, b) => {
                        const priceA = parseInt(String(a.price).replace(/[^\d]/g, ''), 10) || 0;
                        const priceB = parseInt(String(b.price).replace(/[^\d]/g, ''), 10) || 0;

                        return priceB - priceA;
                    });
                    await GM.setValue(STORAGE, JSON.stringify(items));
                    await GM.setValue(TRACKED, tracked);
                });
            }
        }
    });

    observer.observe(targetNode, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
    });
})();
