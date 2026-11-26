const createCitizenReportForm = ({ state, correctionModel, readinessError, escapeHtml, landmarkReadinessError }) => {
    function syncCategoryCards(value, preferredCard = null) {
        const cards = document.querySelectorAll('.citizen-category-card');
        if (!cards.length) return;
        if (!value) {
            cards.forEach(c => {
                c.classList.remove('is-selected');
                c.setAttribute('aria-checked', 'false');
            });
            return;
        }
        if (preferredCard) {
            cards.forEach(c => {
                const isMatch = c === preferredCard;
                c.classList.toggle('is-selected', isMatch);
                c.setAttribute('aria-checked', isMatch ? 'true' : 'false');
            });
            return;
        }
        const alreadySelected = Array.from(cards).find(c => c.classList.contains('is-selected') && (c.dataset.catValue === value || c.dataset.catId === value));
        if (alreadySelected) return;

        let matched = false;
        cards.forEach(c => {
            const matches = !matched && (c.dataset.catValue === value || c.dataset.catId === value);
            if (matches) matched = true;
            c.classList.toggle('is-selected', matches);
            c.setAttribute('aria-checked', matches ? 'true' : 'false');
        });
    }

    function renderCitizenCorrection(result = null) {
        if (!correctionModel || !state.correction) return;
        if (result) state.correction = correctionModel.assess(state.correction, state.generation, result);
        updateSubmitAvailability();
        const group = document.getElementById('citizenCategoryGroup');
        const select = document.getElementById('citizenCategory');
        const explanation = document.getElementById('citizenCategoryExplanation');
        if (!group || !select || !explanation) return;
        group.hidden = !result && !state.correction.categories.length;
        select.innerHTML = '<option value="">Select category</option>' + state.correction.categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
        select.value = state.correction.category || '';
        select.disabled = false;
        explanation.textContent = correctionModel.explanation(state.correction);
        const cardValue = state.correction.category && !state.correction.manual
            ? state.correction.suggestedClass || state.correction.category
            : state.correction.category;
        syncCategoryCards(cardValue || '');
    }

    function updateDescriptionCounter(description) {
        const counter = document.getElementById('charCounter');
        if (counter) counter.textContent = `${description.value.length}/500`;
    }

    function autoFillFromVision(result) {
        const descEl = document.getElementById('description');
        if (!result || !descEl || state.descriptionOwnedByCitizen || descEl.value.trim()) return;

        const description = result.detected
            ? `AI detected: ${result.displayName} (${result.category}).`
            : result.suggestion ? `Possible issue in both photos: ${result.suggestion.displayName}.` : null;
        if (!description) return;
        descEl.value = description;
        state.generatedDescription = description;
        updateDescriptionCounter(descEl);
        updateSubmitAvailability();
    }

    function reportReadinessError() {
        return readinessError({
            photoCount: state.files.length,
            scanState: state.scanState,
            assessment: state.assessment,
            category: state.correction?.category,
            description: document.getElementById('description')?.value
        }) ?? landmarkReadinessError();
    }

    function updateSubmitAvailability() {
        const button = document.getElementById('submitBtn');
        if (button) button.disabled = state.submissionPending
            || state.submittedGeneration === state.generation
            || reportReadinessError() !== null;
    }

    function setupForm(onSubmit) {
        const form = document.getElementById('reportForm');
        if (!form) return;
        if (form.__citizenSubmitBound) return;
        form.__citizenSubmitBound = true;

        const descEl = document.getElementById('description');
        if (descEl) {
            descEl.addEventListener('input', () => {
                state.descriptionOwnedByCitizen = true;
                updateDescriptionCounter(descEl);
                updateSubmitAvailability();
            });
            updateDescriptionCounter(descEl);
        }

        const select = document.getElementById('citizenCategory');
        if (select) {
            select.addEventListener('change', event => {
                const value = event.target.value;
                if (!state.correction || (value && !state.correction.categories.includes(value))) return;
                state.correction = correctionModel.select(state.correction, value);
                renderCitizenCorrection();
                syncCategoryCards(value);
            });
        }

        const cards = document.querySelectorAll('.citizen-category-card');
        cards.forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                const val = card.dataset.catValue;
                if (select && state.correction?.categories.includes(val)) {
                    select.value = val;
                    select.dispatchEvent(new Event('change'));
                }
                syncCategoryCards(val, card);
            });
        });

        if (select && select.value) syncCategoryCards(select.value);
        form.addEventListener('submit', onSubmit);
        updateSubmitAvailability();
    }

    function clearGeneratedDescription() {
        const description = document.getElementById('description');
        if (!state.descriptionOwnedByCitizen && state.generatedDescription && description?.value === state.generatedDescription) {
            description.value = '';
            updateDescriptionCounter(description);
        }
        state.generatedDescription = null;
    }

    function reset() {
        state.descriptionOwnedByCitizen = false;
        state.generatedDescription = null;
        syncCategoryCards('');
        const charCounter = document.getElementById('charCounter');
        if (charCounter) charCounter.textContent = '0/500';
    }

    return { setupForm, renderCitizenCorrection, updateSubmitAvailability, reportReadinessError, autoFillFromVision, clearGeneratedDescription, reset };
};
