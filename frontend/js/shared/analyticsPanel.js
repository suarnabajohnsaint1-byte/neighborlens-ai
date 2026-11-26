(function (root) {
    'use strict';
    function mount(element, scope) {
        if (element.children.length) return;
        element.classList.add('admin-analytics');
        const cityWide = scope === 'City-wide';
        element.innerHTML = `<section class="analytics-period-summary" data-analytics-totals hidden aria-labelledby="analyticsTotalsHeading">
        <h2 id="analyticsTotalsHeading">Period totals</h2>
        <dl><div><dt>Submitted</dt><dd data-analytics-total="submitted"></dd></div>
            <div><dt>Marked ongoing</dt><dd data-analytics-total="ongoing"></dd></div>
            <div><dt>Resolved</dt><dd data-analytics-total="resolved"></dd></div></dl>
    </section>
    <div class="analytics-row">
        <section class="analytics-panel" aria-labelledby="reportTrendsHeading">
            <header class="analytics-heading"><div><h2 id="reportTrendsHeading">Report trends</h2><p>Daily submissions, ongoing, and resolved reports</p></div>
                <div class="analytics-controls">
                    <span class="analytics-chart-style"><i class="bx bx-bar-chart-alt-2" aria-hidden="true"></i>
                        <select aria-label="Trend chart style" data-analytics-chart-style><option value="line">Line</option><option value="curve">Curve</option><option value="bar">Bars</option></select>
                    </span>
                    <div class="analytics-switch" role="group" aria-label="Analytics period" data-analytics-ranges>
                        <button type="button" data-analytics-days="7" aria-pressed="false">7D</button><button type="button" data-analytics-days="30" aria-pressed="true">30D</button><button type="button" data-analytics-days="90" aria-pressed="false">90D</button>
                    </div>
                </div>
            </header>
            <div id="reportTrendsChart" class="analytics-plot" role="img" aria-labelledby="reportTrendsHeading" aria-describedby="analyticsDescription"></div>
        </section>
        <section class="analytics-panel" aria-labelledby="reportCategoriesHeading">
            <header class="analytics-heading analytics-category-heading"><h2 id="reportCategoriesHeading">Reports by category</h2>
                <div class="analytics-controls">
                    ${cityWide ? '<label>Barangay <select data-analytics-barangay><option value="">All Barangays</option></select></label>' : ''}
                    <div class="analytics-switch" role="group" aria-label="Category chart style" data-analytics-category-switch>
                        <button type="button" aria-controls="reportCategoriesChart" data-category-style="bar" aria-pressed="true">Bars</button>
                        <button type="button" aria-controls="reportCategoriesChart" data-category-style="pie" aria-pressed="false">Pie</button>
                    </div>
                </div>
                <p data-analytics-period>30 days - Asia/Manila</p>
            </header>
            <div class="analytics-category-layout" data-category-layout="bar">
                <div class="analytics-category-plot">
                    <div id="reportCategoriesChart" class="analytics-plot" role="img" aria-labelledby="reportCategoriesHeading" aria-describedby="analyticsDescription"></div>
                    <div class="analytics-pie-total" hidden><strong></strong><span>Reports</span></div>
                </div>
                <ul class="analytics-category-key" aria-label="Category shares" hidden></ul>
            </div>
        </section>
    </div>
    ${cityWide ? `<section class="analytics-panel" aria-labelledby="analyticsBarangayHeading" data-analytics-area-panel hidden>
        <header class="analytics-heading"><div><h2 id="analyticsBarangayHeading">Reports by Barangay</h2>
        <p>Reports submitted in the selected period and their current status.</p></div></header>
        <div id="analyticsBarangayChart" class="analytics-plot analytics-barangay-plot" role="img" aria-labelledby="analyticsBarangayHeading"></div>
        <details><summary>View barangay breakdown</summary>
        <div class="analytics-table-scroll"><table><thead><tr><th scope="col">Barangay</th><th scope="col">Submitted</th><th scope="col">Ongoing</th><th scope="col">Resolved</th></tr></thead><tbody data-analytics-area-rows></tbody></table></div></details>
        <nav class="portal-pagination" data-analytics-area-pagination aria-label="Barangay pagination">
            <span id="analyticsBarangayPageInfo" class="portal-page-info" role="status" aria-live="polite"></span>
            <label class="portal-page-size">Per page
                <select aria-label="Barangays per page"><option>5</option><option selected>10</option><option>15</option></select>
            </label>
            <div class="portal-page-buttons">
                <button id="analyticsBarangayPrev" class="portal-icon-button" type="button" data-area-page="-1" aria-label="Previous barangays"><i class="bx bx-chevron-left" aria-hidden="true"></i></button>
                <span id="analyticsBarangayPageNumber" class="portal-page-number"></span>
                <button id="analyticsBarangayNext" class="portal-icon-button" type="button" data-area-page="1" aria-label="Next barangays"><i class="bx bx-chevron-right" aria-hidden="true"></i></button>
            </div>
        </nav>
    </section>` : ''}
    <p class="analytics-history" data-analytics-history hidden></p>
    <div class="analytics-footer">
    <div class="analytics-feedback" role="status" aria-live="polite"><span data-analytics-message></span><button type="button" class="portal-text-button" data-analytics-retry hidden><i class="bx bx-refresh" aria-hidden="true"></i>Retry</button></div>
    <details class="analytics-data"><summary>View chart data</summary>
        <h2 class="analytics-section-title">Report breakdown</h2>
        <p id="analyticsDescription" class="analytics-description"></p><div class="analytics-tables">
        <div><h3>Daily report events</h3>
            ${cityWide ? '<label class="portal-page-size">Daily events scope <select data-analytics-daily-scope><option value="grouped">By barangay</option><option value="city">City-wide totals</option></select></label>' : ''}
            <div class="analytics-table-scroll"><table id="analyticsDailyTable"><thead><tr><th scope="col" aria-label="Date (Asia/Manila)">Date</th>${cityWide ? '<th scope="col">Barangay</th>' : ''}<th scope="col">Submitted</th><th scope="col">Ongoing</th><th scope="col">Resolved</th></tr></thead><tbody data-analytics-daily></tbody></table></div>
            <nav class="portal-pagination" data-analytics-pagination aria-label="Daily report events pagination" hidden>
                <span id="analyticsDailyPageInfo" class="portal-page-info" role="status" aria-live="polite"></span>
                <label class="portal-page-size">Per page
                    <select aria-label="${cityWide ? 'Rows' : 'Days'} per page"><option>3</option><option>5</option><option selected>10</option><option>20</option><option>50</option></select>
                </label>
                <div class="portal-page-buttons">
                    <button id="analyticsDailyPrev" class="portal-icon-button" type="button" data-daily-page="-1" aria-label="Previous page" aria-controls="analyticsDailyTable"><i class="bx bx-chevron-left" aria-hidden="true"></i></button>
                    <span id="analyticsDailyPageNumber" class="portal-page-number"></span>
                    <button id="analyticsDailyNext" class="portal-icon-button" type="button" data-daily-page="1" aria-label="Next page" aria-controls="analyticsDailyTable"><i class="bx bx-chevron-right" aria-hidden="true"></i></button>
                </div>
            </nav>
        </div>
        <div><h3>Category totals</h3><p data-analytics-category-scope>Share of reports submitted in the selected period.</p><table><thead><tr><th scope="col">Category</th><th scope="col">Reports</th><th scope="col">Share</th></tr></thead><tbody data-analytics-categories></tbody></table></div>
    </div></details>
    </div>`;
        element.querySelector('#analyticsDescription').textContent = `${scope} analytics for the selected period, independent of list filters. Each report counts once by its primary damage category. Ongoing and resolved use each report's first recorded transition into that status, including reports submitted before the period. Missing ongoing history is not inferred.`;
    }
    root.AnalyticsPanel = { mount };
})(window);
