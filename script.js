// ========================================
// Blue Sky Cattery - Main JavaScript
// ========================================

// --- Mobile Navigation ---
document.addEventListener('DOMContentLoaded', function () {
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');

    if (navToggle && navMenu) {
        navToggle.addEventListener('click', function () {
            navMenu.classList.toggle('nav-open');
            navToggle.classList.toggle('nav-active');
        });

        // Close menu on link click
        navMenu.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', function () {
                navMenu.classList.remove('nav-open');
                navToggle.classList.remove('nav-active');
            });
        });
    }

    // --- Navbar scroll behavior (home page only) ---
    const navbar = document.getElementById('navbar');
    if (navbar && !navbar.classList.contains('navbar-solid')) {
        window.addEventListener('scroll', function () {
            if (window.scrollY > 80) {
                navbar.classList.add('navbar-scrolled');
            } else {
                navbar.classList.remove('navbar-scrolled');
            }
        });
    }

    // --- Scroll animations ---
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.feature-card, .breed-preview-card, .royal-card, .kitten-card, .step, .philosophy-card, .faq-item, .included-card, .gallery-item').forEach(function (el) {
        el.classList.add('animate-target');
        observer.observe(el);
    });

    // --- Smooth scroll for anchor links ---
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
        anchor.addEventListener('click', function (e) {
            var targetId = this.getAttribute('href');
            if (targetId === '#') return;
            var target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                var offset = 80;
                var pos = target.getBoundingClientRect().top + window.pageYOffset - offset;
                window.scrollTo({ top: pos, behavior: 'smooth' });
            }
        });
    });

    // --- API Base ---
    var API = 'https://portal.blueskycattery.com/api';

    // --- Dynamic Kings & Queens from API ---
    var royalsGrid = document.querySelector('.royals-grid');
    if (royalsGrid) {
        fetch(API + '/cats')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.cats || !data.cats.length) return;
                royalsGrid.innerHTML = '';
                data.cats.forEach(function (cat) {
                    var badgeClass = cat.role === 'king' ? 'king-badge' : 'queen-badge';
                    var badgeText = cat.role === 'king' ? 'King' : 'Queen';
                    var details = [cat.registration || 'CFA Registered'];
                    if (cat.health_tested) details.push('Health Tested');
                    if (cat.color) details.push(cat.color);

                    var card = document.createElement('div');
                    card.className = 'royal-card animate-target animate-in';
                    card.innerHTML =
                        '<div class="royal-badge ' + badgeClass + '">' + badgeText + '</div>' +
                        '<div class="royal-image"><img src="' + (cat.photo_url || '') + '" alt="' + cat.name + ' - ' + cat.breed + '" loading="lazy"></div>' +
                        '<div class="royal-info">' +
                            '<h3>' + cat.name + '</h3>' +
                            '<p class="royal-breed">' + (cat.breed || '') + '</p>' +
                            '<p class="royal-desc">' + (cat.bio || '') + '</p>' +
                            '<div class="royal-details">' + details.map(function (d) { return '<span>' + d + '</span>'; }).join('') + '</div>' +
                        '</div>';
                    royalsGrid.appendChild(card);
                });
            }).catch(function () { /* fail silently - static HTML fallback */ });
    }

    // --- Dynamic pricing from config ---
    var pricingBar = document.querySelector('.pricing-bar');
    if (pricingBar) {
        fetch(API + '/config')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.config) return;
                var c = data.config;
                var price = c.kitten_base_price || '1,800';
                var deposit = c.deposit_amount || '500';
                var info = pricingBar.querySelector('.pricing-info p');
                if (info) {
                    info.innerHTML = '<strong>Starting at $' + Number(price).toLocaleString() + '</strong> for approved pet owners (no breeding rights). Breeding rights are available for selected candidates at an additional fee. A <strong>$' + deposit + ' non-refundable deposit</strong> secures your kitten, applied toward the total adoption fee.';
                }
            }).catch(function () {});
    }

    // --- Dynamic FAQ pricing ---
    var faqPricing = document.getElementById('faqPricing');
    if (faqPricing) {
        fetch(API + '/config')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.config) return;
                var c = data.config;
                faqPricing.textContent = 'Oriental Shorthair kittens start at $' + Number(c.kitten_base_price || 1800).toLocaleString() + ' for pet quality. Breeding rights are reserved for selected candidates and priced separately. A $' + (c.deposit_amount || 500) + ' non-refundable deposit secures your kitten, applied toward the total fee.';
            }).catch(function () {});
    }

    // --- Live kitten status from API ---
    var kittensGrid = document.getElementById('kittensGrid');
    if (kittensGrid) {
        fetch(API + '/kittens/status')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.kittens || !data.kittens.length) return;
                var cards = kittensGrid.querySelectorAll('.kitten-card');
                data.kittens.forEach(function (k, i) {
                    var card = cards[i];
                    if (!card) return;

                    // Update status badge
                    var badge = card.querySelector('.kitten-status');
                    if (badge) {
                        badge.className = 'kitten-status ' + k.status;
                        var labels = { available: 'Available', pending: 'Pending Deposit', reserved: 'Reserved', sold: 'Sold' };
                        badge.textContent = labels[k.status] || k.status;
                    }

                    // Update name
                    var nameEl = card.querySelector('.kitten-info h3');
                    if (nameEl && k.name) nameEl.textContent = k.name;

                    // Update color
                    var colorEl = card.querySelector('.kitten-color');
                    if (colorEl && k.color && k.color !== 'TBD') {
                        var colorText = k.color;
                        if (k.sex) colorText += ' \u2014 ' + (k.sex === 'male' ? 'Male' : k.sex === 'female' ? 'Female' : k.sex);
                        colorEl.textContent = colorText;
                    }

                    // Hide reserve button if not available
                    var btn = card.querySelector('.btn-reserve');
                    if (btn) {
                        if (k.status !== 'available') {
                            btn.disabled = true;
                            btn.style.opacity = '0.5';
                            btn.style.cursor = 'not-allowed';
                            if (k.status === 'sold') { btn.textContent = 'Sold'; btn.style.background = '#8B3A3A'; }
                            else if (k.status === 'reserved') { btn.textContent = 'Reserved'; btn.style.background = '#D4AF37'; btn.style.color = '#3E3229'; }
                            else if (k.status === 'pending') { btn.textContent = 'Reservation Pending'; btn.style.background = '#87A5B4'; }
                        }
                    }
                });
            }).catch(function () { /* fail silently - static fallback */ });
    }
});


// --- Reservation Modal ---
var selectedKitten = null;

function openReservation(kittenNum) {
    selectedKitten = kittenNum;
    var modal = document.getElementById('reservationModal');
    var kittenName = document.getElementById('modalKittenName');
    var form = document.getElementById('reservationForm');
    var success = document.getElementById('formSuccess');

    kittenName.textContent = 'Kitten #' + kittenNum;
    // Set hidden fields for the native form submission
    var kittenField = document.getElementById('resKitten');
    var subjectField = document.getElementById('resSubject');
    if (kittenField) kittenField.value = 'Kitten #' + kittenNum;
    if (subjectField) subjectField.value = 'Kitten Reservation Request - Kitten #' + kittenNum;

    form.style.display = 'block';
    success.style.display = 'none';
    modal.classList.add('modal-active');
    document.body.style.overflow = 'hidden';
}

function closeReservation() {
    var modal = document.getElementById('reservationModal');
    modal.classList.remove('modal-active');
    document.body.style.overflow = '';
}

// (Old FormSubmit handler removed - using submitReserveForm via portal API now)

// Close modal on overlay click
document.addEventListener('click', function (e) {
    if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('modal-active')) {
        closeReservation();
    }
});

// Close modal on Escape
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        closeReservation();
    }
});


// --- Portal API ---
var PORTAL_API = API || 'https://portal.blueskycattery.com/api';

// Contact Form - sends to portal API, redirects to thanks page
function submitContactForm(e) {
    e.preventDefault();
    var form = document.getElementById('contactForm');
    var submitBtn = form.querySelector('button[type="submit"]');
    var fd = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { data[k] = v; });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    fetch(PORTAL_API + '/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(function (res) { return res.json(); })
    .then(function (result) {
        if (result.success) {
            window.location.href = 'thanks.html';
        } else {
            alert('Something went wrong. Please try again or email kittens@blueskycattery.com directly.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send Message';
        }
    }).catch(function () {
        alert('Connection error. Please try again or email kittens@blueskycattery.com directly.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';
    });
    return false;
}

// Reservation Form - sends to portal API, redirects to thanks page
function submitReserveForm(e) {
    e.preventDefault();
    var form = document.getElementById('reservationForm');
    var submitBtn = form.querySelector('button[type="submit"]');
    var fd = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { data[k] = v; });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    fetch(PORTAL_API + '/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(function (res) { return res.json(); })
    .then(function (result) {
        if (result.success) {
            window.location.href = 'thanks.html';
        } else {
            alert('Something went wrong. Please try again or email kittens@blueskycattery.com directly.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Reservation Request';
        }
    }).catch(function () {
        alert('Connection error. Please try again or email kittens@blueskycattery.com directly.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Reservation Request';
    });
    return false;
}
