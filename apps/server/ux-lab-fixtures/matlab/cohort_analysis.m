% Synthetic UX Lab fixture. No real subject or patient data is used.
group_a = [12.4, 13.1, 12.8, 13.5, 12.9];
group_b = [11.8, 12.2, 11.9, 12.4, 12.1];

fprintf('Scient MATLAB UX Lab\n');
fprintf('Analyzing two synthetic cohorts...\n');
fprintf('Group A mean: %.2f\n', mean(group_a));
fprintf('Group B mean: %.2f\n', mean(group_b));
fprintf('Difference: %.2f\n', mean(group_a) - mean(group_b));
