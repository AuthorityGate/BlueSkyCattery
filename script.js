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
                    card.style.cursor = 'pointer';
                    card.onclick = function() { showCatProfile(cat); };
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
                    card.style.cursor = 'pointer';
                    card.onclick = function(e) { if (!e.target.closest('.btn-reserve')) showKittenProfile(k, data.litter_code); };

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

                    // Update color and sex
                    var colorEl = card.querySelector('.kitten-color');
                    if (colorEl) {
                        var parts = [];
                        // Sex badge
                        var sexLabel = k.sex === 'male' ? 'Male' : k.sex === 'female' ? 'Female' : 'TBD';
                        var sexIcon = k.sex === 'male' ? '\u2642' : k.sex === 'female' ? '\u2640' : '\u2754';
                        var sexColor = k.sex === 'male' ? '#87A5B4' : k.sex === 'female' ? '#D4879B' : '#C8B88A';
                        // Color info
                        var colorText = (k.color && k.color !== 'TBD' && k.color !== 'Color developing') ? k.color : 'Color developing';
                        colorEl.innerHTML = '<span style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:.8rem;font-weight:700;background:' + sexColor + ';color:#fff;margin-right:6px">' + sexIcon + ' ' + sexLabel + '</span>' + colorText;
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

    // If user is already logged into the portal, hide account creation
    var hasPortalToken = localStorage.getItem('bsc_portal_token');
    var accountSection = document.getElementById('resAccountSection');
    var loggedInNotice = document.getElementById('resLoggedInNotice');
    if (hasPortalToken && accountSection && loggedInNotice) {
        accountSection.style.display = 'none';
        loggedInNotice.style.display = 'block';
        // Remove required from password fields
        var pw = document.getElementById('resPassword');
        var pwc = document.getElementById('resPasswordConfirm');
        if (pw) pw.removeAttribute('required');
        if (pwc) pwc.removeAttribute('required');
    } else if (accountSection && loggedInNotice) {
        accountSection.style.display = 'block';
        loggedInNotice.style.display = 'none';
    }
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


// --- Signup Form ---
function submitSignup(e, type) {
    e.preventDefault();
    var form = e.target;
    var btn = form.querySelector('button[type="submit"]');
    var fd = new FormData(form);
    var data = { name: fd.get('name'), email: fd.get('email'), type: type };
    // Include waitlist preferences if present
    if (fd.get('sex_preference')) data.sex_preference = fd.get('sex_preference');
    if (fd.get('color_preference')) data.color_preference = fd.get('color_preference');
    if (fd.get('temperament_preference')) data.temperament_preference = fd.get('temperament_preference');
    if (fd.get('eye_color_preference')) data.eye_color_preference = fd.get('eye_color_preference');
    if (fd.get('other_preference')) data.other_preference = fd.get('other_preference');

    btn.disabled = true;
    btn.textContent = 'Signing up...';

    fetch('https://portal.blueskycattery.com/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(function (r) { return r.json(); })
    .then(function (result) {
        if (result.success) {
            form.innerHTML = '<p style="text-align:center;color:#7A8B6F;font-weight:600;padding:16px">You\'re signed up! We\'ll be in touch.</p>';
        } else {
            alert(result.error || 'Something went wrong');
            btn.disabled = false;
            btn.textContent = type === 'waitlist' ? 'Join the Waitlist' : 'Subscribe';
        }
    }).catch(function () {
        alert('Connection error. Please try again.');
        btn.disabled = false;
        btn.textContent = type === 'waitlist' ? 'Join the Waitlist' : 'Subscribe';
    });
    return false;
}

// --- Cat/Kitten Profile Modal ---
function showCatProfile(cat) {
    var overlay = document.createElement('div');
    overlay.className = 'profile-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); document.body.style.overflow = ''; } };

    var modal = document.createElement('div');
    modal.className = 'profile-modal';

    var badgeText = cat.role === 'king' ? 'King' : 'Queen';
    var badgeColor = cat.role === 'king' ? '#87A5B4' : '#C8849B';

    var html = '<button class="profile-close" onclick="this.closest(\'.profile-overlay\').remove();document.body.style.overflow=\'\'">&times;</button>';
    html += '<div class="profile-header">';
    html += '<div class="profile-hero"><img src="' + (cat.photo_url || '') + '" alt="' + cat.name + '"></div>';
    html += '<div class="profile-title">';
    html += '<span style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:.78rem;font-weight:700;background:' + badgeColor + ';color:#fff;text-transform:uppercase;margin-bottom:8px">' + badgeText + '</span>';
    html += '<h2>' + cat.name + '</h2>';
    html += '<p class="profile-breed">' + (cat.breed || 'Oriental Shorthair') + '</p>';
    html += '</div></div>';

    if (cat.bio) html += '<div class="profile-bio"><p>' + cat.bio + '</p></div>';

    html += '<div class="profile-details">';
    if (cat.color) html += '<div class="profile-detail"><span class="detail-label">Color</span><span>' + cat.color + '</span></div>';
    if (cat.registration) html += '<div class="profile-detail"><span class="detail-label">Registration</span><span>' + cat.registration + '</span></div>';
    if (cat.health_tested) html += '<div class="profile-detail"><span class="detail-label">Health Tested</span><span style="color:#7A8B6F;font-weight:700">Yes &#10003;</span></div>';
    html += '</div>';

    // Photo gallery placeholder
    html += '<div class="profile-gallery" id="catGallery' + cat.id + '"></div>';

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Fetch additional photos
    fetch(PORTAL_API + '/photos/cat/' + cat.id)
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var gallery = document.getElementById('catGallery' + cat.id);
            if (!gallery || !data.photos || data.photos.length <= 0) return;
            var ghtml = '<h3 style="margin:20px 0 12px;font-size:1rem;color:#A0522D">Photo Gallery</h3>';
            ghtml += '<div class="gallery-thumbs">';
            data.photos.forEach(function(p) {
                ghtml += '<div class="gallery-thumb" onclick="this.closest(\'.profile-modal\').querySelector(\'.profile-hero img\').src=\'' + p.url + '\'"><img src="' + p.url + '" alt="Photo"></div>';
            });
            ghtml += '</div>';
            gallery.innerHTML = ghtml;
        }).catch(function() {});
}

function showKittenProfile(kitten, litterCode) {
    var overlay = document.createElement('div');
    overlay.className = 'profile-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); document.body.style.overflow = ''; } };

    var modal = document.createElement('div');
    modal.className = 'profile-modal';

    var sexLabel = kitten.sex === 'male' ? 'Male' : kitten.sex === 'female' ? 'Female' : 'TBD';
    var sexIcon = kitten.sex === 'male' ? '\u2642' : kitten.sex === 'female' ? '\u2640' : '';
    var sexColor = kitten.sex === 'male' ? '#87A5B4' : kitten.sex === 'female' ? '#D4879B' : '#C8B88A';
    var statusColors = { available: '#7A8B6F', reserved: '#D4AF37', pending: '#87A5B4', sold: '#8B3A3A' };
    var statusLabels = { available: 'Available', pending: 'Pending Deposit', reserved: 'Reserved', sold: 'Sold' };
    var statusColor = statusColors[kitten.status] || '#6B5B4B';

    var html = '<button class="profile-close" onclick="this.closest(\'.profile-overlay\').remove();document.body.style.overflow=\'\'">&times;</button>';
    html += '<div class="profile-header">';
    html += '<div class="profile-hero"><img src="' + (kitten.photo_url || 'Images/PXL_20260317_165644165.PORTRAIT.jpg') + '" alt="' + (kitten.name || 'Kitten') + '"></div>';
    html += '<div class="profile-title">';
    html += '<div style="display:flex;gap:8px;margin-bottom:8px">';
    html += '<span style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:.78rem;font-weight:700;background:' + sexColor + ';color:#fff">' + sexIcon + ' ' + sexLabel + '</span>';
    html += '<span style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:.78rem;font-weight:700;background:' + statusColor + ';color:#fff">' + (statusLabels[kitten.status] || kitten.status) + '</span>';
    html += '</div>';
    html += '<h2>' + (kitten.name || 'Kitten #' + kitten.number) + '</h2>';
    html += '<p class="profile-breed">Oriental Shorthair &mdash; ' + (litterCode || '') + '</p>';
    html += '</div></div>';

    if (kitten.bio) html += '<div class="profile-bio"><p>' + kitten.bio + '</p></div>';

    html += '<div class="profile-details">';
    if (kitten.color && kitten.color !== 'TBD' && kitten.color !== 'Color developing') html += '<div class="profile-detail"><span class="detail-label">Color</span><span>' + kitten.color + '</span></div>';
    html += '<div class="profile-detail"><span class="detail-label">Sex</span><span>' + sexLabel + '</span></div>';
    html += '<div class="profile-detail"><span class="detail-label">Status</span><span style="color:' + statusColor + ';font-weight:700">' + (statusLabels[kitten.status] || kitten.status) + '</span></div>';
    if (kitten.price) html += '<div class="profile-detail"><span class="detail-label">Starting At</span><span>$' + Number(kitten.price).toLocaleString() + '</span></div>';
    html += '</div>';

    if (kitten.status === 'available') {
        // Check if user is already logged into the portal
        var hasPortalToken = localStorage.getItem('bsc_portal_token');
        if (hasPortalToken) {
            html += '<div style="text-align:center;margin:16px 24px"><a href="https://portal.blueskycattery.com" class="btn btn-primary" style="display:inline-block;text-decoration:none">Go to Portal to Complete Application</a></div>';
        } else {
            html += '<div style="text-align:center;margin:16px 24px"><button class="btn btn-primary" onclick="this.closest(\'.profile-overlay\').remove();openReservation(' + kitten.number + ')">Reserve ' + (kitten.name || 'This Kitten') + '</button></div>';
        }
    }

    html += '<div class="profile-gallery" id="kittenGallery' + kitten.number + '"></div>';

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Fetch additional photos
    fetch(PORTAL_API + '/photos/kitten/' + (kitten.id || kitten.number))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var gallery = document.getElementById('kittenGallery' + kitten.number);
            if (!gallery || !data.photos || data.photos.length <= 0) return;
            var ghtml = '<h3 style="margin:20px 0 12px;font-size:1rem;color:#A0522D">Photo Gallery</h3>';
            ghtml += '<div class="gallery-thumbs">';
            data.photos.forEach(function(p) {
                ghtml += '<div class="gallery-thumb" onclick="this.closest(\'.profile-modal\').querySelector(\'.profile-hero img\').src=\'' + p.url + '\'"><img src="' + p.url + '" alt="Photo"></div>';
            });
            ghtml += '</div>';
            gallery.innerHTML = ghtml;
        }).catch(function() {});
}

// Close profile on Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        var overlay = document.querySelector('.profile-overlay');
        if (overlay) { overlay.remove(); document.body.style.overflow = ''; }
    }
});

// --- Portal API ---
var PORTAL_API = 'https://portal.blueskycattery.com/api';

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

// Reservation Form - sends to portal API, creates account, redirects to portal
function submitReserveForm(e) {
    e.preventDefault();
    var form = document.getElementById('reservationForm');
    var submitBtn = form.querySelector('button[type="submit"]');
    var fd = new FormData(form);
    var data = {};
    fd.forEach(function (v, k) { if (k !== 'password_confirm') data[k] = v; });

    // Validate passwords only if account creation section is visible
    var hasPortalToken = localStorage.getItem('bsc_portal_token');
    if (!hasPortalToken) {
        var pass = fd.get('password');
        var confirmPw = fd.get('password_confirm');
        if (!pass || pass.length < 8) {
            alert('Password must be at least 8 characters.');
            return false;
        }
        if (pass !== confirmPw) {
            alert('Passwords do not match.');
            return false;
        }
    } else {
        // Logged in - remove password from data
        delete data.password;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = hasPortalToken ? 'Submitting...' : 'Creating your account...';

    fetch(PORTAL_API + '/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(function (res) { return res.json(); })
    .then(function (result) {
        if (result.success && hasPortalToken) {
            // Already logged in - go straight to portal
            window.location.href = 'https://portal.blueskycattery.com';
        } else if (result.success && result.token) {
            window.location.href = 'https://portal.blueskycattery.com/?token=' + result.token;
        } else if (result.success && result.needsVerification) {
            // Show verification message instead of redirecting
            var form = document.getElementById('reservationForm');
            var success = document.getElementById('formSuccess');
            form.style.display = 'none';
            success.style.display = 'block';
            success.innerHTML = '<div class="success-icon">&#9993;</div><h3>Check Your Email!</h3><p>Your reservation has been saved. We sent a verification link to <strong>' + data.email + '</strong>.</p><p style="font-size:.85rem;color:#6B5B4B;margin-top:8px">Click the link in your email to access the Adoption Portal and complete your application.</p><button class="btn btn-secondary" onclick="closeReservation()">Close</button>';
        } else if (result.success) {
            window.location.href = 'thanks.html';
        } else {
            alert(result.error || 'Something went wrong. Please try again or email kittens@blueskycattery.com directly.');
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
